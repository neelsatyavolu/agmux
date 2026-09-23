//! Bounded, best-effort hints only; the caller verifies actual disk deltas.
//! This is deliberately a small literal grammar, not a shell/Python interpreter.
use std::collections::HashMap;

const MAX_COMMAND: usize = 64 * 1024;
const MAX_TOKENS: usize = 8192;
const MAX_TARGETS: usize = 128;

/// Only sequential, unconditional literal calls. Metadata calls are allowed
/// alongside shells, but their strings can never become shell commands.
pub(super) fn exec_commands(input: &str) -> Option<Vec<serde_json::Value>> {
    Some(literal_exec_calls(input)?.into_iter().filter_map(|(name, args)| (name == "exec_command").then_some(args)).collect())
}

pub(super) fn exec_waits(input: &str) -> Option<Vec<(i64, usize)>> {
    Some(literal_exec_calls(input)?.into_iter().enumerate().filter_map(|(index, (name, args))|
        (name == "write_stdin").then(|| args.get("session_id").and_then(serde_json::Value::as_i64).map(|id| (id, index))).flatten()
    ).collect())
}

pub(super) fn exec_result_count(input: &str) -> Option<usize> {
    Some(literal_exec_calls(input)?.len())
}

fn literal_exec_calls(input: &str) -> Option<Vec<(String, serde_json::Value)>> {
    let calls = printed_exec_calls(input, false)?;
    // Patch totals come from explicit patch/result evidence, never from shell
    // snapshots of the same compound wrapper (which would double-count).
    if calls.iter().any(|(name, _)| name == "apply_patch") { return None; }
    Some(calls.into_iter().filter(|(name, _)| matches!(name.as_str(), "exec_command" | "write_stdin")).collect())
}

fn printed_exec_calls(input: &str, require_print: bool) -> Option<Vec<(String, serde_json::Value)>> {
    if input.len() > MAX_COMMAND { return None; }
    let mut rest = input.trim();
    if rest.starts_with("// @exec:") {
        let (pragma, body) = rest.split_once('\n')?;
        let value: serde_json::Value = serde_json::from_str(pragma.strip_prefix("// @exec:")?.trim()).ok()?;
        if !value.as_object()?.iter().all(|(key, value)|
            matches!(key.as_str(), "yield_time_ms" | "max_output_tokens") && value.as_u64().is_some()) { return None; }
        rest = body.trim_start();
    }
    let mut commands = Vec::new();
    let mut calls = 0;
    while !rest.trim().is_empty() {
        calls += 1;
        if calls > 32 { return None; }
        let wrapped = rest.trim_start().starts_with("text");
        if require_print && !wrapped { return None; }
        if wrapped { take(&mut rest, "text")?; take(&mut rest, "(")?; }
        take(&mut rest, "await")?;
        if !rest.starts_with(char::is_whitespace) { return None; }
        take(&mut rest, "tools.")?;
        let end = rest.find(|c: char| !c.is_ascii_alphanumeric() && c != '_')?;
        let name = rest.get(..end)?;
        if !matches!(name, "exec_command" | "write_stdin" | "apply_patch") && !matches!(name,
            "mcp__agmux_memory__memory_list" | "mcp__agmux_memory__memory_get" |
            "mcp__agmux_memory__memory_add" | "mcp__agmux_memory__memory_update" |
            "mcp__agmux_memory__session_upsert" | "mcp__agmux_memory__search") { return None; }
        rest = rest.get(end..)?;
        take(&mut rest, "(")?;
        let args = literal_value(&mut rest, 0)?;
        take(&mut rest, ")")?;
        if wrapped { take(&mut rest, ")")?; }
        if name == "exec_command" {
            if args.get("cmd").and_then(serde_json::Value::as_str).is_none() { return None; }
            if !args.as_object()?.iter().all(|(key, value)| match key.as_str() {
                "cmd" | "workdir" | "shell" | "justification" | "sandbox_permissions" => value.is_string(),
                "yield_time_ms" | "max_output_tokens" => value.as_u64().is_some(),
                "login" | "tty" => value.is_boolean(),
                "prefix_rule" => value.as_array().is_some_and(|items| items.iter().all(serde_json::Value::is_string)),
                _ => false,
            }) { return None; }
        } else if name == "write_stdin" {
            if args.get("session_id").and_then(serde_json::Value::as_i64).is_none() { return None; }
            if !args.as_object()?.iter().all(|(key, value)| match key.as_str() {
                "session_id" => value.as_i64().is_some(),
                "chars" => value.as_str() == Some(""),
                "yield_time_ms" | "max_output_tokens" => value.as_u64().is_some(),
                _ => false,
            }) { return None; }
        } else if name == "apply_patch" && !args.is_string() {
            return None;
        }
        commands.push((name.to_string(), args));
        rest = rest.trim_start();
        if rest.is_empty() { break; }
        take(&mut rest, ";")?;
    }
    Some(commands)
}

/// Recover only patches paired with an actual successful printed apply_patch
/// result. `{}` is this executor's successful result; unknown/error output is
/// not success. Shell/MCP results retain their positions in a compound call.
pub(super) fn exec_patch_sources(source: &str, output: &serde_json::Value) -> Vec<String> {
    let Some(calls) = printed_exec_calls(source, true) else { return Vec::new() };
    let decoded;
    let output = if let Some(text) = output.as_str() {
        let Ok(value) = serde_json::from_str::<serde_json::Value>(text) else { return Vec::new() };
        decoded = value;
        &decoded
    } else { output };
    let Some(blocks) = output.as_array() else { return Vec::new() };
    let mut results = Vec::new();
    for (index, block) in blocks.iter().enumerate() {
        if block.get("type").and_then(serde_json::Value::as_str) != Some("input_text") { return Vec::new(); }
        let Some(text) = block.get("text").and_then(serde_json::Value::as_str) else { return Vec::new() };
        if index == 0 && text.starts_with("Script completed\n") && text.ends_with("Output:\n") { continue; }
        // Keep malformed/failed output as an occupied slot. Dropping it could
        // shift a later successful result onto a patch that never applied.
        results.push(serde_json::from_str::<serde_json::Value>(text).ok());
    }
    if results.len() != calls.len() { return Vec::new(); }
    calls.into_iter().zip(results).filter_map(|((name, args), result)| {
        if name != "apply_patch" || !result.as_ref()?.as_object()?.is_empty() { return None; }
        let patch = args.as_str()?;
        (patch.starts_with("*** Begin Patch\n") && patch.trim_end().ends_with("*** End Patch")).then(|| patch.to_string())
    }).collect()
}

// Parse data literals, never expressions. In particular, quoted source code
// and object values containing calls/branches are not searched for tool names.
fn literal_value(rest: &mut &str, depth: usize) -> Option<serde_json::Value> {
    if depth > 12 { return None; }
    *rest = rest.trim_start();
    if rest.starts_with('{') {
        take(rest, "{")?;
        let mut fields = serde_json::Map::new();
        loop {
            *rest = rest.trim_start();
            if rest.starts_with('}') { take(rest, "}")?; break; }
            let key = if rest.starts_with('"') { json_scalar(rest)?.as_str()?.to_string() }
            else {
                let end = rest.find(|c: char| !c.is_ascii_alphanumeric() && c != '_')?;
                let key = rest.get(..end)?.to_string();
                if key.is_empty() || key.starts_with(char::is_numeric) { return None; }
                *rest = rest.get(end..)?;
                key
            };
            take(rest, ":")?;
            if fields.insert(key, literal_value(rest, depth + 1)?).is_some() { return None; }
            *rest = rest.trim_start();
            if rest.starts_with('}') { take(rest, "}")?; break; }
            take(rest, ",")?;
        }
        Some(serde_json::Value::Object(fields))
    } else if rest.starts_with('[') {
        take(rest, "[")?;
        let mut items = Vec::new();
        loop {
            *rest = rest.trim_start();
            if rest.starts_with(']') { take(rest, "]")?; break; }
            items.push(literal_value(rest, depth + 1)?);
            *rest = rest.trim_start();
            if rest.starts_with(']') { take(rest, "]")?; break; }
            take(rest, ",")?;
        }
        Some(serde_json::Value::Array(items))
    } else { json_scalar(rest) }
}

/// Compatibility helper for callers expecting exactly one shell command.
#[cfg(test)]
fn unwrap_exec(input: &str) -> Option<serde_json::Value> {
    let mut commands = exec_commands(input)?;
    if commands.len() != 1 { return None; }
    commands.pop()
}

fn take(rest: &mut &str, literal: &str) -> Option<()> {
    *rest = rest.trim_start().strip_prefix(literal)?;
    Some(())
}

fn json_scalar(rest: &mut &str) -> Option<serde_json::Value> {
    *rest = rest.trim_start();
    // Avoid deserializing nested data at all; this grammar only accepts scalars.
    if !rest.starts_with(|c: char| c == '"' || c.is_ascii_digit() || matches!(c, 't' | 'f' | 'n' | '-')) { return None; }
    let mut stream = serde_json::Deserializer::from_str(rest).into_iter::<serde_json::Value>();
    let value = stream.next()?.ok()?;
    *rest = rest.get(stream.byte_offset()..)?;
    Some(value)
}

pub(super) fn shell_targets(tool: &str, input: &serde_json::Value) -> Vec<String> {
    if !matches!(tool, "Bash" | "bash" | "exec_command" | "run_shell_command"
        | "run_terminal_cmd" | "execute_command" | "Shell" | "terminal" | "run_command"
        | "shell" | "run_terminal_command" | "execute") {
        return Vec::new();
    }
    let Some(command) = ["command", "cmd", "CommandLine", "command_line", "Command"].iter()
        .find_map(|key| input.get(*key)) else { return Vec::new() };
    let mut out = Vec::new();
    if let Some(command) = command.as_str() {
        shell(command, 0, &mut out);
    } else if let Some(args) = command.as_array() {
        // Arrays are argv, never shell text joined with spaces.
        if args.len() <= MAX_TOKENS && args.iter().try_fold(0usize, |size, v|
            size.checked_add(v.as_str()?.len())).is_some_and(|size| size <= MAX_COMMAND) {
            if let Some(args) = args.iter().map(|v| v.as_str().map(str::to_owned))
                .collect::<Option<Vec<_>>>() {
                if args.iter().map(String::len).sum::<usize>() <= MAX_COMMAND {
                    invocation(&args, 0, &mut out);
                }
            }
        }
    }
    out
}

fn add(out: &mut Vec<String>, path: &str) {
    if out.len() < MAX_TARGETS && !path.is_empty() && path.len() <= 4096
        && path != "-" && !path.starts_with('~')
        && !path.chars().any(|c| c.is_control() || "$`*?[]{}".contains(c))
        && !out.iter().any(|p| p == path) {
        out.push(path.to_owned());
    }
}

#[derive(Debug, PartialEq)]
enum Token { Word(String), String(String), Payload, Op(char) }

// Quoted contents stay opaque. Shell expansions and complex syntax cause a skip;
// Python strings are distinct tokens so examples cannot become executable code.
fn lex(source: &str, python: bool) -> Option<Vec<Token>> {
    let mut chars = source.chars().peekable();
    let mut tokens = Vec::new();
    let mut word = String::new();
    let mut started = false;
    while let Some(c) = chars.next() {
        if tokens.len() >= MAX_TOKENS { return None; }
        if c == '#' && !started {
            while chars.peek().is_some_and(|c| *c != '\n') { chars.next(); }
        } else if c == '\'' || c == '"' {
            if python && started {
                if word != "b" { return None; } // Only bytes payloads, not interpolated strings.
                tokens.push(Token::Word(std::mem::take(&mut word)));
                started = false;
            }
            let mut value = String::new();
            let mut literal = true;
            loop {
                let next = chars.next()?;
                if next == c { break; }
                if next == '\\' {
                    let escaped = chars.next()?;
                    if python {
                        // Escapes in edit payloads need not be decoded. Mark the
                        // whole string opaque so it cannot become a path/mode.
                        if !matches!(escaped, '\\' | '\'' | '"') { literal = false; }
                        value.push(escaped);
                    } else if c == '"' {
                        if !matches!(escaped, '$' | '`' | '"' | '\\' | '\n') { value.push('\\'); }
                        if escaped != '\n' { value.push(escaped); }
                    } else {
                        value.push(next);
                        value.push(escaped);
                    }
                } else {
                    if !python && c == '"' && matches!(next, '$' | '`') { return None; }
                    value.push(next);
                }
            }
            if python { tokens.push(if literal { Token::String(value) } else { Token::Payload }); }
            else { word.push_str(&value); started = true; }
        } else if c.is_whitespace() || (if python { "();=.,+" } else { ";|&><" }).contains(c) {
            if started { tokens.push(Token::Word(std::mem::take(&mut word))); started = false; }
            if c == '\n' || !c.is_whitespace() { tokens.push(Token::Op(c)); }
        } else {
            if !python && "$`(){}\\".contains(c) { return None; }
            word.push(c);
            started = true;
        }
    }
    if started { tokens.push(Token::Word(word)); }
    (tokens.len() <= MAX_TOKENS).then_some(tokens)
}

fn shell(command: &str, depth: usize, out: &mut Vec<String>) {
    if command.len() > MAX_COMMAND || depth > 4 { return; }
    // Parse initial Python stdin / cat redirect heredocs through their first
    // exact terminator; skip all following shell commands.
    // A preceding cd/compound header is rejected, so relative paths keep cwd.
    if command.contains("<<") {
        if let Some((header, body)) = command.split_once('\n') {
            if let Some((exe, delimiter)) = header.split_once("<<") {
                let exe = exe.trim();
                let delimiter = delimiter.trim();
                let delimiter = delimiter.strip_prefix('\'').and_then(|s| s.strip_suffix('\''))
                    .unwrap_or(delimiter);
                if !delimiter.is_empty() && delimiter.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
                    let mut offset = 0;
                    for line in body.split_inclusive('\n') {
                        if line.strip_suffix('\n').unwrap_or(line) == delimiter {
                            if matches!(exe, "python" | "python3" | "python -" | "python3 -") {
                                python(&body[..offset], out);
                            } else if let Some(tokens) = lex(exe, false) {
                                // Exact `cat > literal`/`cat >> literal` only.
                                // Never tokenize the heredoc body as commands.
                                match tokens.as_slice() {
                                    [Token::Word(cat), Token::Op('>'), Token::Word(path)] |
                                    [Token::Word(cat), Token::Op('>'), Token::Op('>'), Token::Word(path)] if cat == "cat" => add(out, path),
                                    _ => {}
                                }
                            }
                            break;
                        }
                        offset += line.len();
                    }
                }
            }
        }
        return;
    }
    let Some(tokens) = lex(command, false) else { return; };
    let start = out.len();
    // Even an opaque nested argument may change cwd (e.g. eval). Suppress
    // relative hints throughout rather than attempting shell control flow.
    let mut changed_cwd = command.split(|c: char| !c.is_alphanumeric() && c != '_')
        .any(|word| matches!(word, "cd" | "pushd" | "popd"));
    for segment in tokens.split(|t| matches!(t, Token::Op(';' | '\n' | '|' | '&'))) {
        let Some(Token::Word(exe)) = segment.first() else { continue; };
        let exe = exe.rsplit('/').next().unwrap_or(exe);
        if matches!(exe, "cd" | "pushd" | "popd") { changed_cwd = true; }
        if exe == "apply_patch" { continue; }
        let mut args = Vec::new();
        let mut i = 0;
        while i < segment.len() {
            match &segment[i] {
                Token::Op('>') => {
                    i += 1;
                    if segment.get(i) == Some(&Token::Op('>')) { i += 1; }
                    if let Some(Token::Word(path)) = segment.get(i) { add(out, path); }
                }
                Token::Word(arg) => {
                    if !(segment.get(i + 1) == Some(&Token::Op('>'))
                        && arg.chars().all(|c| c.is_ascii_digit())) {
                        args.push(arg.clone());
                    }
                },
                _ => {},
            }
            i += 1;
        }
        invocation(&args, depth, out);
    }
    if changed_cwd {
        let mut index = 0;
        out.retain(|p| { let keep = index < start || p.starts_with('/'); index += 1; keep });
    }
}

fn invocation(args: &[String], depth: usize, out: &mut Vec<String>) {
    let Some(exe) = args.first() else { return; };
    let exe = exe.rsplit('/').next().unwrap_or(exe);
    if matches!(exe, "bash" | "sh" | "zsh") && args.len() == 3
        && matches!(args[1].as_str(), "-c" | "-lc") {
        shell(&args[2], depth + 1, out);
    } else if matches!(exe, "python" | "python3") && args.len() == 3 && args[1] == "-c" {
        python(&args[2], out);
    } else if exe == "tee" {
        let mut options = true;
        let mut files = Vec::new();
        for arg in &args[1..] {
            if options && arg == "--" { options = false; continue; }
            if options && matches!(arg.as_str(), "-a" | "--append" | "-i" | "--ignore-interrupts") { continue; }
            if options && arg.starts_with('-') { return; }
            files.push(arg);
        }
        for file in files { add(out, file); }
    } else if exe == "sed" {
        let mut inplace = false;
        let mut script = false;
        let mut i = 1;
        let mut files = Vec::new();
        while i < args.len() {
            let arg = &args[i];
            if arg.starts_with("-i") {
                inplace = true;
                if arg == "-i" && args.get(i + 1).is_some_and(String::is_empty) { i += 1; }
            } else if arg == "-e" {
                i += 1;
                if i >= args.len() { return; }
                script = true;
            } else if matches!(arg.as_str(), "-n" | "-E" | "-r") {
            } else if arg.starts_with('-') { return;
            } else if !script {
                // The bare operand following GNU -i is a script; a separate
                // BSD backup suffix is ambiguous. Only accept substitutions.
                if !arg.starts_with('s') || arg.chars().nth(1).is_none_or(|c| c.is_alphanumeric()) { return; }
                script = true;
            } else { files.push(arg); }
            i += 1;
        }
        if inplace && script { for file in files { add(out, file); } }
    }
}

fn python(code: &str, out: &mut Vec<String>) {
    // No blocks, continuations, or multiline strings: only straight-line calls.
    if code.len() > MAX_COMMAND || code.lines().any(|line| !line.trim().is_empty()
        && !line.trim_start().starts_with('#') && line.starts_with([' ', '\t'])) { return; }
    let Some(tokens) = lex(code, true) else { return; };
    let mut vars = HashMap::<String, (String, bool)>::new();
    let mut found = Vec::new();
    for statement in tokens.split(|t| matches!(t, Token::Op(';' | '\n'))) {
        if statement.is_empty() { continue; }
        if let [Token::Word(name), Token::Op('='), rest @ ..] = statement {
            vars.remove(name);
            if let Some((path, consumed, is_path)) = python_path(rest, &vars) {
                if consumed == rest.len() { vars.insert(name.clone(), (path, is_path)); }
            }
            continue;
        }
        let mut recognized = false;
        if let Some((path, consumed, true)) = python_path(statement, &vars) {
            if let [Token::Op('.'), Token::Word(method), Token::Op('('), ..] = &statement[consumed..] {
                if matches!(method.as_str(), "write_text" | "write_bytes") { add(&mut found, &path); recognized = true; }
            }
        }
        if let [Token::Word(name), Token::Op('('), rest @ ..] = statement {
            if name == "open" {
                if let Some((path, consumed, _)) = python_path(rest, &vars) {
                    if let [Token::Op(','), Token::String(mode), Token::Op(')' | ','), ..] = &rest[consumed..] {
                        if matches!(mode.as_str(), "w" | "a" | "wb" | "ab" | "w+" | "a+" | "wb+" | "ab+") {
                            add(&mut found, &path);
                            recognized = true;
                        }
                    }
                }
            }
        }
        if !recognized { vars.clear(); }
    }
    let changes_cwd = tokens.iter().any(|t| matches!(t, Token::Word(s) if s == "chdir"));
    for path in found { if !changes_cwd || path.starts_with('/') { add(out, &path); } }
}

fn python_path(tokens: &[Token], vars: &HashMap<String, (String, bool)>) -> Option<(String, usize, bool)> {
    match tokens {
        [Token::String(path), ..] => Some((path.clone(), 1, false)),
        [Token::Word(name), Token::Op('('), Token::String(path), Token::Op(')'), ..] if name == "Path" => Some((path.clone(), 4, true)),
        [Token::Word(module), Token::Op('.'), Token::Word(name), Token::Op('('), Token::String(path), Token::Op(')'), ..]
            if module == "pathlib" && name == "Path" => Some((path.clone(), 6, true)),
        [Token::Word(name), ..] => vars.get(name).cloned().map(|(path, is_path)| (path, 1, is_path)),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn targets(command: &str) -> Vec<String> {
        shell_targets("Bash", &json!({"command": command}))
    }

    #[test]
    fn literal_exec_wrappers() {
        for wrapper in [
            r#"text(await tools.exec_command({cmd: "echo hi > out", workdir: "/repo", max_output_tokens: 1000}));"#,
            r#"await tools.exec_command({"cmd":"echo hi > out","workdir":"/repo"})"#,
            "// @exec: {\"yield_time_ms\": 1000}\ntext(await tools.exec_command({cmd: \"echo hi > out\", workdir: \"/repo\"}));",
        ] {
            let input = unwrap_exec(wrapper).expect(wrapper);
            assert_eq!(input["cmd"], "echo hi > out");
            assert_eq!(input["workdir"], "/repo");
        }
        assert_eq!(unwrap_exec(r#"await tools.exec_command({cmd: "echo \u0061 > out\n"})"#).unwrap()["cmd"], "echo a > out\n");
    }

    #[test]
    fn exec_rejects_nonliteral_code() {
        for wrapper in [
            r#"if (false) text(await tools.exec_command({cmd:"echo > fake"}));"#,
            r#""text(await tools.exec_command({cmd: \"echo > fake\"}));""#,
            r#"// text(await tools.exec_command({cmd:"echo > fake"}));"#,
            r#"await tools.exec_command({cmd: command})"#,
            r#"await tools.exec_command({cmd: `echo > fake`})"#,
            r#"await tools.exec_command({cmd:"echo" + " > fake"})"#,
            r#"await tools.exec_command({cmd:"one",cmd:"two"})"#,
            r#"await tools.exec_command({cmd:"one", ...options})"#,
            r#"await tools.exec_command({cmd:"one", unknown: true})"#,
            r#"await tools.exec_command({cmd:"one"}); await tools.exec_command({cmd:"two"})"#,
            r#"await tools.exec_command({cmd:"one" /* comment */})"#,
        ] { assert!(unwrap_exec(wrapper).is_none(), "{wrapper}"); }
    }

    #[test]
    fn provider_shapes() {
        for tool in ["Bash", "bash", "exec_command", "run_shell_command", "run_terminal_cmd", "execute_command", "Shell", "terminal", "shell", "run_terminal_command", "execute"] {
            for key in ["command", "cmd", "CommandLine"] {
                assert_eq!(shell_targets(tool, &json!({key: "echo hi > out.txt"})), ["out.txt"]);
            }
        }
        assert_eq!(shell_targets("terminal", &json!({"command": ["bash", "-lc", "echo hi > out"]})), ["out"]);
        assert!(shell_targets("exec", &json!({"cmd": "echo hi > out"})).is_empty());
    }

    #[test]
    fn gemini_and_hermes_command_shapes() {
        for key in ["command", "command_line", "CommandLine", "Command"] {
            assert_eq!(shell_targets("run_command", &json!({key: "echo hi > gemini"})), ["gemini"]);
        }
        assert_eq!(shell_targets("terminal", &json!({"command": "echo hi > hermes"})), ["hermes"]);
    }

    #[test]
    fn shell_writes() {
        assert_eq!(targets("printf hi > 'a b'; echo ok >> log; echo x | tee -a one two; sed -i '' 's/a/b/' three"), ["a b", "log", "one", "two", "three"]);
        assert_eq!(targets("sed -i.bak -e 's/a/b/' file; sed -i 's/c/d/' file"), ["file"]);
        assert_eq!(targets("echo hi 2> errors"), ["errors"]);
    }

    #[test]
    fn cat_heredoc_writes_only_the_redirect_target() {
        assert_eq!(targets("cat > src/lib/codexThreadsCache.ts <<'EOF'\nexport const value = 1;\n// echo fake > not-a-write\nEOF\nnpm test"), ["src/lib/codexThreadsCache.ts"]);
        assert_eq!(targets("cat >> 'a b.txt' <<'EOF'\nhello\nEOF"), ["a b.txt"]);
        assert!(targets("cat <<'EOF'\necho hi > fake\nEOF").is_empty());
        assert!(targets("cat > file <<'EOF'\nunterminated").is_empty());
        assert!(targets("cd elsewhere; cat > file <<'EOF'\nhi\nEOF").is_empty());
        assert!(targets("cat > $TARGET <<'EOF'\nhi\nEOF").is_empty());
    }

    #[test]
    fn sequential_literal_exec_and_memory_call_keep_shell_input() {
        let source = r#"text(await tools.exec_command({cmd:"python3 - <<'PY'\np='src/example.ts'\nopen(p,'w').write('hello')\nPY\ngit diff --check",max_output_tokens:1000}));
text(await tools.mcp__agmux_memory__session_upsert({title:"Done",summary:"Changed file"}));"#;
        let commands = exec_commands(source).unwrap();
        assert_eq!(commands.len(), 1);
        assert_eq!(shell_targets("exec_command", &commands[0]), ["src/example.ts"]);
        assert!(exec_commands("if (false) { text(await tools.exec_command({cmd:\"echo hi > fake\"})); }").is_none());
        assert!(exec_commands("text('await tools.exec_command({cmd:\"echo hi > fake\"})')").is_none());
        assert!(exec_commands("text(await tools.exec_command({cmd:makeCommand()}));").is_none());
    }

    #[test]
    fn literal_waits_keep_their_executor_result_position() {
        let source = r#"text(await tools.write_stdin({session_id:79058,chars:"",yield_time_ms:1000}));
text(await tools.exec_command({cmd:"npx tsc --noEmit"}));"#;
        assert_eq!(exec_waits(source), Some(vec![(79058, 0)]));
        assert_eq!(exec_commands(source).unwrap().len(), 1);
        assert!(exec_waits(r#"text(await tools.write_stdin({session_id:79058,chars:"rm file\n"}));"#).is_none());
    }

    #[test]
    fn wrapped_patch_success_is_independent_of_following_test_process() {
        let patch = "*** Begin Patch\n*** Update File: a.rs\n@@\n-old\n+let text = \"\\n\";\n*** End Patch";
        let source = format!("text(await tools.apply_patch({}));\ntext(await tools.exec_command({{cmd:\"cargo test\"}}));", serde_json::to_string(patch).unwrap());
        let output = json!([
            {"type":"input_text","text":"Script completed\nWall time 1 seconds\nOutput:\n"},
            {"type":"input_text","text":"{}"},
            {"type":"input_text","text":"{\"session_id\":28810,\"output\":\"tests running\",\"wall_time_seconds\":1}"}
        ]);
        assert_eq!(exec_patch_sources(&source, &output), [patch]);
        assert!(exec_commands(&source).is_none(), "same wrapper must not also produce shell snapshot totals");
        let mut failed = output.clone();
        failed[1]["text"] = json!("{\"error\":\"patch failed\"}");
        assert!(exec_patch_sources(&source, &failed).is_empty());
        assert!(exec_patch_sources(&source, &json!([{"type":"input_text","text":"{}"}])).is_empty());
    }

    #[test]
    fn patch_results_do_not_invent_calls_from_examples_or_shift_missing_results() {
        let patch = "*** Begin Patch\n*** Add File: a\n+x\n*** End Patch";
        let call = format!("text(await tools.apply_patch({}));", serde_json::to_string(patch).unwrap());
        let ok = json!([{"type":"input_text","text":"{}"}]);
        assert!(exec_patch_sources(&format!("if(false){{{call}}}"), &ok).is_empty());
        assert!(exec_patch_sources(&format!("text({});", serde_json::to_string(&call).unwrap()), &ok).is_empty());
        let source = format!("text(await tools.exec_command({{cmd:\"rg x\"}}));{call}");
        assert!(exec_patch_sources(&source, &ok).is_empty());
        assert_eq!(exec_patch_sources(&source, &json!([
            {"type":"input_text","text":"unavailable tool result"},
            {"type":"input_text","text":"{}"}
        ])), [patch]);
    }

    #[test]
    fn python_writes() {
        assert_eq!(targets(r#"python3 -c "from pathlib import Path; Path('a').write_text('hi'); p=Path('b'); p.write_bytes(b'x'); q='c'; open(q,'a').write('x'); open('d','w')""#), ["a", "b", "c", "d"]);
        assert_eq!(targets("python3 <<'PY'\nfrom pathlib import Path\np = Path('héllo')\np.write_text('yes')\nPY"), ["héllo"]);
    }

    #[test]
    fn python_edit_payload_escapes_and_heredoc_suffix() {
        let script = r#"python3 <<'PY'
from pathlib import Path
p=Path('src/example.ts')
s=p.read_text()
s=s.replace('old','new\n')
p.write_text(s)
PY"#;
        for suffix in ["", "\nnpm test", "\nnpm test\n", "\ncd elsewhere; echo x > unrelated"] {
            assert_eq!(targets(&format!("{script}{suffix}")), ["src/example.ts"]);
        }
        assert!(targets(&format!("cd sub && {script}\nnpm test")).is_empty());
        assert!(targets(&script.replace("\nPY", "\n PY")).is_empty());
    }

    #[test]
    fn python_payload_concatenation_does_not_hide_known_write_target() {
        assert_eq!(targets("python3 - <<'PY'\np='src/example.ts'\ns=open(p).read(); needle='old'; s=s.replace(needle,needle+'new'); open(p,'w').write(s)\nPY"), ["src/example.ts"]);
        assert!(targets("python3 - <<'PY'\np='prefix'+'dynamic'; open(p,'w').write('x')\nPY").is_empty());
    }

    #[test]
    fn python_escaped_payloads_are_not_path_literals() {
        assert_eq!(targets(r#"python3 <<'PY'
from pathlib import Path
Path('real').write_text('new\n\t\x41\u0042')
Path('bad\npath').write_text('x')
open('bad\x41', 'w')
p='bad\u0042'
open(p, 'a')
PY"#), ["real"]);
    }

    #[test]
    fn no_examples_reads_or_dynamic_paths() {
        for command in [
            "cat file; sed 's/a/b/' file", "# echo hi > fake\ncat real",
            "echo 'echo hi > fake'", "printf '%s' \"Path('fake').write_text('x')\"",
            "apply_patch '*** Begin Patch > fake'", "echo hi > $TARGET", "echo hi > *.txt",
            "cat <<'EOF'\necho hi > fake\nEOF", "python3 -c \"print(\\\"open('fake','w')\\\")\"",
            "python3 -c \"p='old'; p=get_path(); open(p,'w')\"",
            "python3 -c \"open('read','r'); Path('read').read_text()\"",
            "python3 -c \"s=\\\"Path('fake').write_text('x')\\\"\"",
            "echo hi > foo$(date)", "echo hi > 'unterminated",
        ] { assert!(targets(command).is_empty(), "{command}"); }
    }

    #[test]
    fn ambiguous_syntax_does_not_invent_targets() {
        for command in [
            "sed -i .bak 's/a/b/' file",
            "python3 -c \"'example'.write_text('x')\"",
            "python3 -c \"p='example'; p.write_text('x')\"",
            "python3 -c \"p='old'; del p; open(p,'w')\"",
            "python3 -c \"p='old'; p += 'new'; open(p,'w')\"",
            "echo x | tee file --unsupported",
        ] { assert!(targets(command).is_empty(), "{command}"); }
        assert_eq!(targets("sed -i 's/a/b/' file 2> errors"), ["errors", "file"]);
        assert!(targets("eval 'cd sub'; echo x > relative").is_empty());
    }

    #[test]
    fn cwd_and_bounds() {
        assert_eq!(targets("cd sub && echo x > relative; echo x > /tmp/absolute"), ["/tmp/absolute"]);
        assert_eq!(targets("bash -lc 'cd sub; echo x > relative; echo x > /tmp/absolute'"), ["/tmp/absolute"]);
        assert!(targets(&format!("echo {} > out", "x".repeat(70_000))).is_empty());
    }
}
