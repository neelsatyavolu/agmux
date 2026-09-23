warning: unexpected `cfg` condition value: `cargo-clippy`
  --> src/commands/native_terminal.rs:63:57
   |
63 |                 ClassDecl::new("XanomTerminalTextView", class!(NSTextView)).expect("class");
   |                                                         ^^^^^^^^^^^^^^^^^^
   |
   = note: no expected values for `feature`
   = note: using a cfg inside a macro will use the cfgs from the destination crate and not the ones from the defining crate
   = help: try referring to `class` crate for guidance on how handle this unexpected cfg
   = help: the macro `class` may come from an old version of the `objc` crate, try updating your dependency with `cargo update -p objc`
   = note: see <https://doc.rust-lang.org/nightly/rustc/check-cfg/cargo-specifics.html> for more information about checking conditional configuration
   = note: `#[warn(unexpected_cfgs)]` on by default
   = note: this warning originates in the macro `class` (in Nightly builds, run with -Z macro-backtrace for more info)

warning: unexpected `cfg` condition value: `cargo-clippy`
  --> src/commands/native_terminal.rs:66:21
   |
66 |                     sel!(keyDown:),
   |                     ^^^^^^^^^^^^^^
   |
Temporary Codex UI edit test line.
   = note: no expected values for `feature`
   = note: using a cfg inside a macro will use the cfgs from the destination crate and not the ones from the defining crate
   = help: try referring to `sel_impl` crate for guidance on how handle this unexpected cfg
   = help: the macro `sel_impl` may come from an old version of the `objc` crate, try updating your dependency with `cargo update -p objc`
   = note: see <https://doc.rust-lang.org/nightly/rustc/check-cfg/cargo-specifics.html> for more information about checking conditional configuration
   = note: this warning originates in the macro `sel_impl` which comes from the expansion of the macro `sel` (in Nightly builds, run with -Z macro-backtrace for more info)

warning: unexpected `cfg` condition value: `cargo-clippy`
  --> src/commands/native_terminal.rs:70:21
   |
70 |                     sel!(paste:),
   |                     ^^^^^^^^^^^^
   |
   = note: no expected values for `feature`
   = note: using a cfg inside a macro will use the cfgs from the destination crate and not the ones from the defining crate
   = help: try referring to `sel_impl` crate for guidance on how handle this unexpected cfg
   = help: the macro `sel_impl` may come from an old version of the `objc` crate, try updating your dependency with `cargo update -p objc`
   = note: see <https://doc.rust-lang.org/nightly/rustc/check-cfg/cargo-specifics.html> for more information about checking conditional configuration
   = note: this warning originates in the macro `sel_impl` which comes from the expansion of the macro `sel` (in Nightly builds, run with -Z macro-backtrace for more info)

warning: unexpected `cfg` condition value: `cargo-clippy`
  --> src/commands/native_terminal.rs:74:21
   |
74 |                     sel!(scrollWheel:),
   |                     ^^^^^^^^^^^^^^^^^^
   |
   = note: no expected values for `feature`
   = note: using a cfg inside a macro will use the cfgs from the destination crate and not the ones from the defining crate
   = help: try referring to `sel_impl` crate for guidance on how handle this unexpected cfg
   = help: the macro `sel_impl` may come from an old version of the `objc` crate, try updating your dependency with `cargo update -p objc`
   = note: see <https://doc.rust-lang.org/nightly/rustc/check-cfg/cargo-specifics.html> for more information about checking conditional configuration
   = note: this warning originates in the macro `sel_impl` which comes from the expansion of the macro `sel` (in Nightly builds, run with -Z macro-backtrace for more info)

warning: unexpected `cfg` condition value: `cargo-clippy`
  --> src/commands/native_terminal.rs:88:35
   |
88 |             let scroll_view: id = msg_send![this, superview];
   |                                   ^^^^^^^^^^^^^^^^^^^^^^^^^^
   |
   = note: no expected values for `feature`
   = note: using a cfg inside a macro will use the cfgs from the destination crate and not the ones from the defining crate
   = help: try referring to `sel_impl` crate for guidance on how handle this unexpected cfg
   = help: the macro `sel_impl` may come from an old version of the `objc` crate, try updating your dependency with `cargo update -p objc`
   = note: see <https://doc.rust-lang.org/nightly/rustc/check-cfg/cargo-specifics.html> for more information about checking conditional configuration
   = note: this warning originates in the macro `sel_impl` which comes from the expansion of the macro `msg_send` (in Nightly builds, run with -Z macro-backtrace for more info)

warning: unexpected `cfg` condition value: `cargo-clippy`
  --> src/commands/native_terminal.rs:90:37
   |
90 |                 let host_view: id = msg_send![scroll_view, superview];
   |                                     ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
   |
   = note: no expected values for `feature`
   = note: using a cfg inside a macro will use the cfgs from the destination crate and not the ones from the defining crate
   = help: try referring to `sel_impl` crate for guidance on how handle this unexpected cfg
   = help: the macro `sel_impl` may come from an old version of the `objc` crate, try updating your dependency with `cargo update -p objc`
   = note: see <https://doc.rust-lang.org/nightly/rustc/check-cfg/cargo-specifics.html> for more information about checking conditional configuration
   = note: this warning originates in the macro `sel_impl` which comes from the expansion of the macro `msg_send` (in Nightly builds, run with -Z macro-backtrace for more info)

warning: unexpected `cfg` condition value: `cargo-clippy`
   --> src/commands/native_terminal.rs:103:37
    |
103 |                         let _: () = msg_send![host_view, scrollWheel: event];
    |                                     ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
    |
    = note: no expected values for `feature`
    = note: using a cfg inside a macro will use the cfgs from the destination crate and not the ones from the defining crate
    = help: try referring to `sel_impl` crate for guidance on how handle this unexpected cfg
    = help: the macro `sel_impl` may come from an old version of the `objc` crate, try updating your dependency with `cargo update -p objc`
    = note: see <https://doc.rust-lang.org/nightly/rustc/check-cfg/cargo-specifics.html> for more information about checking conditional configuration
    = note: this warning originates in the macro `sel_impl` which comes from the expansion of the macro `msg_send` (in Nightly builds, run with -Z macro-backtrace for more info)

warning: unexpected `cfg` condition value: `cargo-clippy`
   --> src/commands/native_terminal.rs:116:35
    |
116 |             let scroll_view: id = msg_send![this, superview];
    |                                   ^^^^^^^^^^^^^^^^^^^^^^^^^^
    |
    = note: no expected values for `feature`
    = note: using a cfg inside a macro will use the cfgs from the destination crate and not the ones from the defining crate
    = help: try referring to `sel_impl` crate for guidance on how handle this unexpected cfg
    = help: the macro `sel_impl` may come from an old version of the `objc` crate, try updating your dependency with `cargo update -p objc`
    = note: see <https://doc.rust-lang.org/nightly/rustc/check-cfg/cargo-specifics.html> for more information about checking conditional configuration
    = note: this warning originates in the macro `sel_impl` which comes from the expansion of the macro `msg_send` (in Nightly builds, run with -Z macro-backtrace for more info)

warning: unexpected `cfg` condition value: `cargo-clippy`
   --> src/commands/native_terminal.rs:118:37
    |
118 |                 let host_view: id = msg_send![scroll_view, superview];
    |                                     ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
    |
    = note: no expected values for `feature`
    = note: using a cfg inside a macro will use the cfgs from the destination crate and not the ones from the defining crate
    = help: try referring to `sel_impl` crate for guidance on how handle this unexpected cfg
    = help: the macro `sel_impl` may come from an old version of the `objc` crate, try updating your dependency with `cargo update -p objc`
    = note: see <https://doc.rust-lang.org/nightly/rustc/check-cfg/cargo-specifics.html> for more information about checking conditional configuration
    = note: this warning originates in the macro `sel_impl` which comes from the expansion of the macro `msg_send` (in Nightly builds, run with -Z macro-backtrace for more info)

warning: unexpected `cfg` condition value: `cargo-clippy`
   --> src/commands/native_terminal.rs:120:33
    |
120 |                     let _: () = msg_send![host_view, keyDown: event];
    |                                 ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
    |
    = note: no expected values for `feature`
    = note: using a cfg inside a macro will use the cfgs from the destination crate and not the ones from the defining crate
    = help: try referring to `sel_impl` crate for guidance on how handle this unexpected cfg
    = help: the macro `sel_impl` may come from an old version of the `objc` crate, try updating your dependency with `cargo update -p objc`
    = note: see <https://doc.rust-lang.org/nightly/rustc/check-cfg/cargo-specifics.html> for more information about checking conditional configuration
    = note: this warning originates in the macro `sel_impl` which comes from the expansion of the macro `msg_send` (in Nightly builds, run with -Z macro-backtrace for more info)

warning: unexpected `cfg` condition value: `cargo-clippy`
   --> src/commands/native_terminal.rs:130:35
    |
130 |             let scroll_view: id = msg_send![this, superview];
    |                                   ^^^^^^^^^^^^^^^^^^^^^^^^^^
    |
    = note: no expected values for `feature`
    = note: using a cfg inside a macro will use the cfgs from the destination crate and not the ones from the defining crate
    = help: try referring to `sel_impl` crate for guidance on how handle this unexpected cfg
    = help: the macro `sel_impl` may come from an old version of the `objc` crate, try updating your dependency with `cargo update -p objc`
    = note: see <https://doc.rust-lang.org/nightly/rustc/check-cfg/cargo-specifics.html> for more information about checking conditional configuration
    = note: this warning originates in the macro `sel_impl` which comes from the expansion of the macro `msg_send` (in Nightly builds, run with -Z macro-backtrace for more info)

warning: unexpected `cfg` condition value: `cargo-clippy`
   --> src/commands/native_terminal.rs:132:37
    |
132 |                 let host_view: id = msg_send![scroll_view, superview];
    |                                     ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
    |
    = note: no expected values for `feature`
    = note: using a cfg inside a macro will use the cfgs from the destination crate and not the ones from the defining crate
    = help: try referring to `sel_impl` crate for guidance on how handle this unexpected cfg
    = help: the macro `sel_impl` may come from an old version of the `objc` crate, try updating your dependency with `cargo update -p objc`
    = note: see <https://doc.rust-lang.org/nightly/rustc/check-cfg/cargo-specifics.html> for more information about checking conditional configuration
    = note: this warning originates in the macro `sel_impl` which comes from the expansion of the macro `msg_send` (in Nightly builds, run with -Z macro-backtrace for more info)

warning: unexpected `cfg` condition value: `cargo-clippy`
   --> src/commands/native_terminal.rs:134:33
    |
134 |                     let _: () = msg_send![host_view, paste: sender];
    |                                 ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
    |
    = note: no expected values for `feature`
    = note: using a cfg inside a macro will use the cfgs from the destination crate and not the ones from the defining crate
    = help: try referring to `sel_impl` crate for guidance on how handle this unexpected cfg
    = help: the macro `sel_impl` may come from an old version of the `objc` crate, try updating your dependency with `cargo update -p objc`
    = note: see <https://doc.rust-lang.org/nightly/rustc/check-cfg/cargo-specifics.html> for more information about checking conditional configuration
    = note: this warning originates in the macro `sel_impl` which comes from the expansion of the macro `msg_send` (in Nightly builds, run with -Z macro-backtrace for more info)

warning: unexpected `cfg` condition value: `cargo-clippy`
   --> src/commands/native_terminal.rs:145:65
    |
145 |                 ClassDecl::new("XanomNativeClaudeTerminalView", class!(NSView)).expect("class");
    |                                                                 ^^^^^^^^^^^^^^
    |
    = note: no expected values for `feature`
    = note: using a cfg inside a macro will use the cfgs from the destination crate and not the ones from the defining crate
    = help: try referring to `class` crate for guidance on how handle this unexpected cfg
    = help: the macro `class` may come from an old version of the `objc` crate, try updating your dependency with `cargo update -p objc`
    = note: see <https://doc.rust-lang.org/nightly/rustc/check-cfg/cargo-specifics.html> for more information about checking conditional configuration
    = note: this warning originates in the macro `class` (in Nightly builds, run with -Z macro-backtrace for more info)

warning: unexpected `cfg` condition value: `cargo-clippy`
   --> src/commands/native_terminal.rs:148:21
    |
148 |                     sel!(acceptsFirstResponder),
    |                     ^^^^^^^^^^^^^^^^^^^^^^^^^^^
    |
    = note: no expected values for `feature`
    = note: using a cfg inside a macro will use the cfgs from the destination crate and not the ones from the defining crate
    = help: try referring to `sel_impl` crate for guidance on how handle this unexpected cfg
    = help: the macro `sel_impl` may come from an old version of the `objc` crate, try updating your dependency with `cargo update -p objc`
    = note: see <https://doc.rust-lang.org/nightly/rustc/check-cfg/cargo-specifics.html> for more information about checking conditional configuration
    = note: this warning originates in the macro `sel_impl` which comes from the expansion of the macro `sel` (in Nightly builds, run with -Z macro-backtrace for more info)

warning: unexpected `cfg` condition value: `cargo-clippy`
   --> src/commands/native_terminal.rs:151:33
    |
151 |                 decl.add_method(sel!(isFlipped), is_flipped as extern "C" fn(&Object, Sel) -> BOOL);
    |                                 ^^^^^^^^^^^^^^^
    |
    = note: no expected values for `feature`
    = note: using a cfg inside a macro will use the cfgs from the destination crate and not the ones from the defining crate
    = help: try referring to `sel_impl` crate for guidance on how handle this unexpected cfg
    = help: the macro `sel_impl` may come from an old version of the `objc` crate, try updating your dependency with `cargo update -p objc`
    = note: see <https://doc.rust-lang.org/nightly/rustc/check-cfg/cargo-specifics.html> for more information about checking conditional configuration
    = note: this warning originates in the macro `sel_impl` which comes from the expansion of the macro `sel` (in Nightly builds, run with -Z macro-backtrace for more info)

warning: unexpected `cfg` condition value: `cargo-clippy`
   --> src/commands/native_terminal.rs:153:21
    |
153 |                     sel!(mouseDown:),
    |                     ^^^^^^^^^^^^^^^^
    |
    = note: no expected values for `feature`
    = note: using a cfg inside a macro will use the cfgs from the destination crate and not the ones from the defining crate
    = help: try referring to `sel_impl` crate for guidance on how handle this unexpected cfg
    = help: the macro `sel_impl` may come from an old version of the `objc` crate, try updating your dependency with `cargo update -p objc`
    = note: see <https://doc.rust-lang.org/nightly/rustc/check-cfg/cargo-specifics.html> for more information about checking conditional configuration
    = note: this warning originates in the macro `sel_impl` which comes from the expansion of the macro `sel` (in Nightly builds, run with -Z macro-backtrace for more info)

warning: unexpected `cfg` condition value: `cargo-clippy`
   --> src/commands/native_terminal.rs:156:33
    |
156 |                 decl.add_method(sel!(keyDown:), key_down as extern "C" fn(&Object, Sel, id));
    |                                 ^^^^^^^^^^^^^^
    |
    = note: no expected values for `feature`
    = note: using a cfg inside a macro will use the cfgs from the destination crate and not the ones from the defining crate
    = help: try referring to `sel_impl` crate for guidance on how handle this unexpected cfg
    = help: the macro `sel_impl` may come from an old version of the `objc` crate, try updating your dependency with `cargo update -p objc`
    = note: see <https://doc.rust-lang.org/nightly/rustc/check-cfg/cargo-specifics.html> for more information about checking conditional configuration
    = note: this warning originates in the macro `sel_impl` which comes from the expansion of the macro `sel` (in Nightly builds, run with -Z macro-backtrace for more info)

warning: unexpected `cfg` condition value: `cargo-clippy`
   --> src/commands/native_terminal.rs:157:33
    |
157 |                 decl.add_method(sel!(paste:), paste as extern "C" fn(&Object, Sel, id));
    |                                 ^^^^^^^^^^^^
    |
    = note: no expected values for `feature`
    = note: using a cfg inside a macro will use the cfgs from the destination crate and not the ones from the defining crate
    = help: try referring to `sel_impl` crate for guidance on how handle this unexpected cfg
    = help: the macro `sel_impl` may come from an old version of the `objc` crate, try updating your dependency with `cargo update -p objc`
    = note: see <https://doc.rust-lang.org/nightly/rustc/check-cfg/cargo-specifics.html> for more information about checking conditional configuration
    = note: this warning originates in the macro `sel_impl` which comes from the expansion of the macro `sel` (in Nightly builds, run with -Z macro-backtrace for more info)

warning: unexpected `cfg` condition value: `cargo-clippy`
   --> src/commands/native_terminal.rs:159:21
    |
159 |                     sel!(scrollWheel:),
    |                     ^^^^^^^^^^^^^^^^^^
    |
    = note: no expected values for `feature`
    = note: using a cfg inside a macro will use the cfgs from the destination crate and not the ones from the defining crate
    = help: try referring to `sel_impl` crate for guidance on how handle this unexpected cfg
    = help: the macro `sel_impl` may come from an old version of the `objc` crate, try updating your dependency with `cargo update -p objc`
    = note: see <https://doc.rust-lang.org/nightly/rustc/check-cfg/cargo-specifics.html> for more information about checking conditional configuration
    = note: this warning originates in the macro `sel_impl` which comes from the expansion of the macro `sel` (in Nightly builds, run with -Z macro-backtrace for more info)

warning: unexpected `cfg` condition value: `cargo-clippy`
   --> src/commands/native_terminal.rs:177:30
    |
177 |             let window: id = msg_send![this, window];
    |                              ^^^^^^^^^^^^^^^^^^^^^^^
    |
    = note: no expected values for `feature`
    = note: using a cfg inside a macro will use the cfgs from the destination crate and not the ones from the defining crate
    = help: try referring to `sel_impl` crate for guidance on how handle this unexpected cfg
    = help: the macro `sel_impl` may come from an old version of the `objc` crate, try updating your dependency with `cargo update -p objc`
    = note: see <https://doc.rust-lang.org/nightly/rustc/check-cfg/cargo-specifics.html> for more information about checking conditional configuration
    = note: this warning originates in the macro `sel_impl` which comes from the expansion of the macro `msg_send` (in Nightly builds, run with -Z macro-backtrace for more info)

warning: unexpected `cfg` condition value: `cargo-clippy`
   --> src/commands/native_terminal.rs:178:25
    |
178 |             let _: () = msg_send![window, makeFirstResponder: this];
    |                         ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
    |
    = note: no expected values for `feature`
    = note: using a cfg inside a macro will use the cfgs from the destination crate and not the ones from the defining crate
    = help: try referring to `sel_impl` crate for guidance on how handle this unexpected cfg
    = help: the macro `sel_impl` may come from an old version of the `objc` crate, try updating your dependency with `cargo update -p objc`
    = note: see <https://doc.rust-lang.org/nightly/rustc/check-cfg/cargo-specifics.html> for more information about checking conditional configuration
    = note: this warning originates in the macro `sel_impl` which comes from the expansion of the macro `msg_send` (in Nightly builds, run with -Z macro-backtrace for more info)

warning: unexpected `cfg` condition value: `cargo-clippy`
   --> src/commands/native_terminal.rs:196:32
    |
196 |             let delta_y: f64 = msg_send![event, scrollingDeltaY];
    |                                ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
    |
    = note: no expected values for `feature`
    = note: using a cfg inside a macro will use the cfgs from the destination crate and not the ones from the defining crate
    = help: try referring to `sel_impl` crate for guidance on how handle this unexpected cfg
    = help: the macro `sel_impl` may come from an old version of the `objc` crate, try updating your dependency with `cargo update -p objc`
    = note: see <https://doc.rust-lang.org/nightly/rustc/check-cfg/cargo-specifics.html> for more information about checking conditional configuration
    = note: this warning originates in the macro `sel_impl` which comes from the expansion of the macro `msg_send` (in Nightly builds, run with -Z macro-backtrace for more info)

warning: unexpected `cfg` condition value: `cargo-clippy`
   --> src/commands/native_terminal.rs:221:36
    |
221 |                 let subviews: id = msg_send![this, subviews];
    |                                    ^^^^^^^^^^^^^^^^^^^^^^^^^
    |
    = note: no expected values for `feature`
    = note: using a cfg inside a macro will use the cfgs from the destination crate and not the ones from the defining crate
    = help: try referring to `sel_impl` crate for guidance on how handle this unexpected cfg
    = help: the macro `sel_impl` may come from an old version of the `objc` crate, try updating your dependency with `cargo update -p objc`
    = note: see <https://doc.rust-lang.org/nightly/rustc/check-cfg/cargo-specifics.html> for more information about checking conditional configuration
    = note: this warning originates in the macro `sel_impl` which comes from the expansion of the macro `msg_send` (in Nightly builds, run with -Z macro-backtrace for more info)

warning: unexpected `cfg` condition value: `cargo-clippy`
   --> src/commands/native_terminal.rs:222:34
    |
222 |                 let count: u64 = msg_send![subviews, count];
    |                                  ^^^^^^^^^^^^^^^^^^^^^^^^^^
    |
    = note: no expected values for `feature`
    = note: using a cfg inside a macro will use the cfgs from the destination crate and not the ones from the defining crate
    = help: try referring to `sel_impl` crate for guidance on how handle this unexpected cfg
    = help: the macro `sel_impl` may come from an old version of the `objc` crate, try updating your dependency with `cargo update -p objc`
    = note: see <https://doc.rust-lang.org/nightly/rustc/check-cfg/cargo-specifics.html> for more information about checking conditional configuration
    = note: this warning originates in the macro `sel_impl` which comes from the expansion of the macro `msg_send` (in Nightly builds, run with -Z macro-backtrace for more info)

warning: unexpected `cfg` condition value: `cargo-clippy`
   --> src/commands/native_terminal.rs:224:43
    |
224 |                     let scroll_view: id = msg_send![subviews, objectAtIndex: 0u64];
    |                                           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
    |
    = note: no expected values for `feature`
    = note: using a cfg inside a macro will use the cfgs from the destination crate and not the ones from the defining crate
    = help: try referring to `sel_impl` crate for guidance on how handle this unexpected cfg
    = help: the macro `sel_impl` may come from an old version of the `objc` crate, try updating your dependency with `cargo update -p objc`
    = note: see <https://doc.rust-lang.org/nightly/rustc/check-cfg/cargo-specifics.html> for more information about checking conditional configuration
    = note: this warning originates in the macro `sel_impl` which comes from the expansion of the macro `msg_send` (in Nightly builds, run with -Z macro-backtrace for more info)

warning: unexpected `cfg` condition value: `cargo-clippy`
   --> src/commands/native_terminal.rs:225:33
    |
225 |                     let _: () = msg_send![scroll_view, scrollWheel: event];
    |                                 ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
    |
    = note: no expected values for `feature`
    = note: using a cfg inside a macro will use the cfgs from the destination crate and not the ones from the defining crate
    = help: try referring to `sel_impl` crate for guidance on how handle this unexpected cfg
    = help: the macro `sel_impl` may come from an old version of the `objc` crate, try updating your dependency with `cargo update -p objc`
    = note: see <https://doc.rust-lang.org/nightly/rustc/check-cfg/cargo-specifics.html> for more information about checking conditional configuration
    = note: this warning originates in the macro `sel_impl` which comes from the expansion of the macro `msg_send` (in Nightly builds, run with -Z macro-backtrace for more info)

warning: unexpected `cfg` condition value: `cargo-clippy`
   --> src/commands/native_terminal.rs:272:38
    |
272 |         let key_code: u16 = unsafe { msg_send![event, keyCode] };
    |                                      ^^^^^^^^^^^^^^^^^^^^^^^^^
    |
    = note: no expected values for `feature`
    = note: using a cfg inside a macro will use the cfgs from the destination crate and not the ones from the defining crate
    = help: try referring to `sel_impl` crate for guidance on how handle this unexpected cfg
    = help: the macro `sel_impl` may come from an old version of the `objc` crate, try updating your dependency with `cargo update -p objc`
    = note: see <https://doc.rust-lang.org/nightly/rustc/check-cfg/cargo-specifics.html> for more information about checking conditional configuration
    = note: this warning originates in the macro `sel_impl` which comes from the expansion of the macro `msg_send` (in Nightly builds, run with -Z macro-backtrace for more info)

warning: unexpected `cfg` condition value: `cargo-clippy`
   --> src/commands/native_terminal.rs:273:39
    |
273 |         let modifiers: u64 = unsafe { msg_send![event, modifierFlags] };
    |                                       ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
    |
    = note: no expected values for `feature`
    = note: using a cfg inside a macro will use the cfgs from the destination crate and not the ones from the defining crate
    = help: try referring to `sel_impl` crate for guidance on how handle this unexpected cfg
    = help: the macro `sel_impl` may come from an old version of the `objc` crate, try updating your dependency with `cargo update -p objc`
    = note: see <https://doc.rust-lang.org/nightly/rustc/check-cfg/cargo-specifics.html> for more information about checking conditional configuration
    = note: this warning originates in the macro `sel_impl` which comes from the expansion of the macro `msg_send` (in Nightly builds, run with -Z macro-backtrace for more info)

warning: unexpected `cfg` condition value: `cargo-clippy`
   --> src/commands/native_terminal.rs:277:33
    |
277 |                 let value: id = msg_send![event, charactersIgnoringModifiers];
    |                                 ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
    |
    = note: no expected values for `feature`
    = note: using a cfg inside a macro will use the cfgs from the destination crate and not the ones from the defining crate
    = help: try referring to `sel_impl` crate for guidance on how handle this unexpected cfg
    = help: the macro `sel_impl` may come from an old version of the `objc` crate, try updating your dependency with `cargo update -p objc`
    = note: see <https://doc.rust-lang.org/nightly/rustc/check-cfg/cargo-specifics.html> for more information about checking conditional configuration
    = note: this warning originates in the macro `sel_impl` which comes from the expansion of the macro `msg_send` (in Nightly builds, run with -Z macro-backtrace for more info)

warning: unexpected `cfg` condition value: `cargo-clippy`
   --> src/commands/native_terminal.rs:307:29
    |
307 |             let value: id = msg_send![event, charactersIgnoringModifiers];
    |                             ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
    |
    = note: no expected values for `feature`
    = note: using a cfg inside a macro will use the cfgs from the destination crate and not the ones from the defining crate
    = help: try referring to `sel_impl` crate for guidance on how handle this unexpected cfg
    = help: the macro `sel_impl` may come from an old version of the `objc` crate, try updating your dependency with `cargo update -p objc`
    = note: see <https://doc.rust-lang.org/nightly/rustc/check-cfg/cargo-specifics.html> for more information about checking conditional configuration
    = note: this warning originates in the macro `sel_impl` which comes from the expansion of the macro `msg_send` (in Nightly builds, run with -Z macro-backtrace for more info)

warning: unexpected `cfg` condition value: `cargo-clippy`
   --> src/commands/native_terminal.rs:336:34
    |
336 |             let pasteboard: id = msg_send![class!(NSPasteboard), generalPasteboard];
    |                                  ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
    |
    = note: no expected values for `feature`
    = note: using a cfg inside a macro will use the cfgs from the destination crate and not the ones from the defining crate
    = help: try referring to `sel_impl` crate for guidance on how handle this unexpected cfg
    = help: the macro `sel_impl` may come from an old version of the `objc` crate, try updating your dependency with `cargo update -p objc`
    = note: see <https://doc.rust-lang.org/nightly/rustc/check-cfg/cargo-specifics.html> for more information about checking conditional configuration
    = note: this warning originates in the macro `sel_impl` which comes from the expansion of the macro `msg_send` (in Nightly builds, run with -Z macro-backtrace for more info)

warning: unexpected `cfg` condition value: `cargo-clippy`
   --> src/commands/native_terminal.rs:336:44
    |
336 |             let pasteboard: id = msg_send![class!(NSPasteboard), generalPasteboard];
    |                                            ^^^^^^^^^^^^^^^^^^^^
    |
    = note: no expected values for `feature`
    = note: using a cfg inside a macro will use the cfgs from the destination crate and not the ones from the defining crate
    = help: try referring to `class` crate for guidance on how handle this unexpected cfg
    = help: the macro `class` may come from an old version of the `objc` crate, try updating your dependency with `cargo update -p objc`
    = note: see <https://doc.rust-lang.org/nightly/rustc/check-cfg/cargo-specifics.html> for more information about checking conditional configuration
    = note: this warning originates in the macro `class` (in Nightly builds, run with -Z macro-backtrace for more info)

warning: unexpected `cfg` condition value: `cargo-clippy`
   --> src/commands/native_terminal.rs:338:29
    |
338 |             let value: id = msg_send![pasteboard, stringForType: string_type];
    |                             ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
    |
    = note: no expected values for `feature`
    = note: using a cfg inside a macro will use the cfgs from the destination crate and not the ones from the defining crate
    = help: try referring to `sel_impl` crate for guidance on how handle this unexpected cfg
    = help: the macro `sel_impl` may come from an old version of the `objc` crate, try updating your dependency with `cargo update -p objc`
    = note: see <https://doc.rust-lang.org/nightly/rustc/check-cfg/cargo-specifics.html> for more information about checking conditional configuration
    = note: this warning originates in the macro `sel_impl` which comes from the expansion of the macro `msg_send` (in Nightly builds, run with -Z macro-backtrace for more info)

warning: unexpected `cfg` condition value: `cargo-clippy`
   --> src/commands/native_terminal.rs:351:50
    |
351 |         let bytes: *const std::os::raw::c_char = msg_send![value, UTF8String];
    |                                                  ^^^^^^^^^^^^^^^^^^^^^^^^^^^^
    |
    = note: no expected values for `feature`
    = note: using a cfg inside a macro will use the cfgs from the destination crate and not the ones from the defining crate
    = help: try referring to `sel_impl` crate for guidance on how handle this unexpected cfg
    = help: the macro `sel_impl` may come from an old version of the `objc` crate, try updating your dependency with `cargo update -p objc`
    = note: see <https://doc.rust-lang.org/nightly/rustc/check-cfg/cargo-specifics.html> for more information about checking conditional configuration
    = note: this warning originates in the macro `sel_impl` which comes from the expansion of the macro `msg_send` (in Nightly builds, run with -Z macro-backtrace for more info)

warning: unexpected `cfg` condition value: `cargo-clippy`
   --> src/commands/native_terminal.rs:430:32
    |
430 |         let text_storage: id = msg_send![text_view, textStorage];
    |                                ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
    |
    = note: no expected values for `feature`
    = note: using a cfg inside a macro will use the cfgs from the destination crate and not the ones from the defining crate
    = help: try referring to `sel_impl` crate for guidance on how handle this unexpected cfg
    = help: the macro `sel_impl` may come from an old version of the `objc` crate, try updating your dependency with `cargo update -p objc`
    = note: see <https://doc.rust-lang.org/nightly/rustc/check-cfg/cargo-specifics.html> for more information about checking conditional configuration
    = note: this warning originates in the macro `sel_impl` which comes from the expansion of the macro `msg_send` (in Nightly builds, run with -Z macro-backtrace for more info)

warning: unexpected `cfg` condition value: `cargo-clippy`
   --> src/commands/native_terminal.rs:433:32
    |
433 |         let enclosing_sv: id = msg_send![text_view, enclosingScrollView];
    |                                ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
    |
    = note: no expected values for `feature`
    = note: using a cfg inside a macro will use the cfgs from the destination crate and not the ones from the defining crate
    = help: try referring to `sel_impl` crate for guidance on how handle this unexpected cfg
    = help: the macro `sel_impl` may come from an old version of the `objc` crate, try updating your dependency with `cargo update -p objc`
    = note: see <https://doc.rust-lang.org/nightly/rustc/check-cfg/cargo-specifics.html> for more information about checking conditional configuration
    = note: this warning originates in the macro `sel_impl` which comes from the expansion of the macro `msg_send` (in Nightly builds, run with -Z macro-backtrace for more info)

warning: unexpected `cfg` condition value: `cargo-clippy`
   --> src/commands/native_terminal.rs:435:33
    |
435 |             let clip_view: id = msg_send![enclosing_sv, contentView];
    |                                 ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
    |
    = note: no expected values for `feature`
    = note: using a cfg inside a macro will use the cfgs from the destination crate and not the ones from the defining crate
    = help: try referring to `sel_impl` crate for guidance on how handle this unexpected cfg
    = help: the macro `sel_impl` may come from an old version of the `objc` crate, try updating your dependency with `cargo update -p objc`
    = note: see <https://doc.rust-lang.org/nightly/rustc/check-cfg/cargo-specifics.html> for more information about checking conditional configuration
    = note: this warning originates in the macro `sel_impl` which comes from the expansion of the macro `msg_send` (in Nightly builds, run with -Z macro-backtrace for more info)

warning: unexpected `cfg` condition value: `cargo-clippy`
   --> src/commands/native_terminal.rs:436:39
    |
436 |             let clip_bounds: NSRect = msg_send![clip_view, bounds];
    |                                       ^^^^^^^^^^^^^^^^^^^^^^^^^^^^
    |
    = note: no expected values for `feature`
    = note: using a cfg inside a macro will use the cfgs from the destination crate and not the ones from the defining crate
    = help: try referring to `sel_impl` crate for guidance on how handle this unexpected cfg
    = help: the macro `sel_impl` may come from an old version of the `objc` crate, try updating your dependency with `cargo update -p objc`
    = note: see <https://doc.rust-lang.org/nightly/rustc/check-cfg/cargo-specifics.html> for more information about checking conditional configuration
    = note: this warning originates in the macro `sel_impl` which comes from the expansion of the macro `msg_send` (in Nightly builds, run with -Z macro-backtrace for more info)

warning: unexpected `cfg` condition value: `cargo-clippy`
   --> src/commands/native_terminal.rs:437:37
    |
437 |             let doc_frame: NSRect = msg_send![text_view, frame];
    |                                     ^^^^^^^^^^^^^^^^^^^^^^^^^^^
    |
    = note: no expected values for `feature`
    = note: using a cfg inside a macro will use the cfgs from the destination crate and not the ones from the defining crate
    = help: try referring to `sel_impl` crate for guidance on how handle this unexpected cfg
    = help: the macro `sel_impl` may come from an old version of the `objc` crate, try updating your dependency with `cargo update -p objc`
    = note: see <https://doc.rust-lang.org/nightly/rustc/check-cfg/cargo-specifics.html> for more information about checking conditional configuration
    = note: this warning originates in the macro `sel_impl` which comes from the expansion of the macro `msg_send` (in Nightly builds, run with -Z macro-backtrace for more info)

warning: unexpected `cfg` condition value: `cargo-clippy`
   --> src/commands/native_terminal.rs:438:36
    |
438 |             let sv_frame: NSRect = msg_send![enclosing_sv, frame];
    |                                    ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
    |
    = note: no expected values for `feature`
    = note: using a cfg inside a macro will use the cfgs from the destination crate and not the ones from the defining crate
    = help: try referring to `sel_impl` crate for guidance on how handle this unexpected cfg
    = help: the macro `sel_impl` may come from an old version of the `objc` crate, try updating your dependency with `cargo update -p objc`
    = note: see <https://doc.rust-lang.org/nightly/rustc/check-cfg/cargo-specifics.html> for more information about checking conditional configuration
    = note: this warning originates in the macro `sel_impl` which comes from the expansion of the macro `msg_send` (in Nightly builds, run with -Z macro-backtrace for more info)

warning: unexpected `cfg` condition value: `cargo-clippy`
   --> src/commands/native_terminal.rs:445:21
    |
445 |         let _: () = msg_send![text_storage, setAttributedString: attributed];
    |                     ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
    |
    = note: no expected values for `feature`
    = note: using a cfg inside a macro will use the cfgs from the destination crate and not the ones from the defining crate
    = help: try referring to `sel_impl` crate for guidance on how handle this unexpected cfg
    = help: the macro `sel_impl` may come from an old version of the `objc` crate, try updating your dependency with `cargo update -p objc`
    = note: see <https://doc.rust-lang.org/nightly/rustc/check-cfg/cargo-specifics.html> for more information about checking conditional configuration
    = note: this warning originates in the macro `sel_impl` which comes from the expansion of the macro `msg_send` (in Nightly builds, run with -Z macro-backtrace for more info)

warning: unexpected `cfg` condition value: `cargo-clippy`
   --> src/commands/native_terminal.rs:449:35
    |
449 |             let full_string: id = msg_send![attributed, string];
    |                                   ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
    |
    = note: no expected values for `feature`
    = note: using a cfg inside a macro will use the cfgs from the destination crate and not the ones from the defining crate
    = help: try referring to `sel_impl` crate for guidance on how handle this unexpected cfg
    = help: the macro `sel_impl` may come from an old version of the `objc` crate, try updating your dependency with `cargo update -p objc`
    = note: see <https://doc.rust-lang.org/nightly/rustc/check-cfg/cargo-specifics.html> for more information about checking conditional configuration
    = note: this warning originates in the macro `sel_impl` which comes from the expansion of the macro `msg_send` (in Nightly builds, run with -Z macro-backtrace for more info)

warning: unexpected `cfg` condition value: `cargo-clippy`
   --> src/commands/native_terminal.rs:450:31
    |
450 |             let length: u64 = msg_send![full_string, length];
    |                               ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
    |
    = note: no expected values for `feature`
    = note: using a cfg inside a macro will use the cfgs from the destination crate and not the ones from the defining crate
    = help: try referring to `sel_impl` crate for guidance on how handle this unexpected cfg
    = help: the macro `sel_impl` may come from an old version of the `objc` crate, try updating your dependency with `cargo update -p objc`
    = note: see <https://doc.rust-lang.org/nightly/rustc/check-cfg/cargo-specifics.html> for more information about checking conditional configuration
    = note: this warning originates in the macro `sel_impl` which comes from the expansion of the macro `msg_send` (in Nightly builds, run with -Z macro-backtrace for more info)

warning: unexpected `cfg` condition value: `cargo-clippy`
   --> src/commands/native_terminal.rs:452:25
    |
452 |             let _: () = msg_send![text_view, scrollRangeToVisible: range];
    |                         ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
    |
    = note: no expected values for `feature`
    = note: using a cfg inside a macro will use the cfgs from the destination crate and not the ones from the defining crate
    = help: try referring to `sel_impl` crate for guidance on how handle this unexpected cfg
    = help: the macro `sel_impl` may come from an old version of the `objc` crate, try updating your dependency with `cargo update -p objc`
    = note: see <https://doc.rust-lang.org/nightly/rustc/check-cfg/cargo-specifics.html> for more information about checking conditional configuration
    = note: this warning originates in the macro `sel_impl` which comes from the expansion of the macro `msg_send` (in Nightly builds, run with -Z macro-backtrace for more info)

warning: unexpected `cfg` condition value: `cargo-clippy`
   --> src/commands/native_terminal.rs:467:25
    |
467 |         let attrs: id = msg_send![class!(NSMutableDictionary), alloc];
    |                         ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
    |
    = note: no expected values for `feature`
    = note: using a cfg inside a macro will use the cfgs from the destination crate and not the ones from the defining crate
    = help: try referring to `sel_impl` crate for guidance on how handle this unexpected cfg
    = help: the macro `sel_impl` may come from an old version of the `objc` crate, try updating your dependency with `cargo update -p objc`
    = note: see <https://doc.rust-lang.org/nightly/rustc/check-cfg/cargo-specifics.html> for more information about checking conditional configuration
    = note: this warning originates in the macro `sel_impl` which comes from the expansion of the macro `msg_send` (in Nightly builds, run with -Z macro-backtrace for more info)

warning: unexpected `cfg` condition value: `cargo-clippy`
   --> src/commands/native_terminal.rs:467:35
    |
467 |         let attrs: id = msg_send![class!(NSMutableDictionary), alloc];
    |                                   ^^^^^^^^^^^^^^^^^^^^^^^^^^^
    |
    = note: no expected values for `feature`
    = note: using a cfg inside a macro will use the cfgs from the destination crate and not the ones from the defining crate
    = help: try referring to `class` crate for guidance on how handle this unexpected cfg
    = help: the macro `class` may come from an old version of the `objc` crate, try updating your dependency with `cargo update -p objc`
    = note: see <https://doc.rust-lang.org/nightly/rustc/check-cfg/cargo-specifics.html> for more information about checking conditional configuration
    = note: this warning originates in the macro `class` (in Nightly builds, run with -Z macro-backtrace for more info)

warning: unexpected `cfg` condition value: `cargo-clippy`
   --> src/commands/native_terminal.rs:468:25
    |
468 |         let attrs: id = msg_send![attrs, init];
    |                         ^^^^^^^^^^^^^^^^^^^^^^
    |
    = note: no expected values for `feature`
    = note: using a cfg inside a macro will use the cfgs from the destination crate and not the ones from the defining crate
    = help: try referring to `sel_impl` crate for guidance on how handle this unexpected cfg
    = help: the macro `sel_impl` may come from an old version of the `objc` crate, try updating your dependency with `cargo update -p objc`
    = note: see <https://doc.rust-lang.org/nightly/rustc/check-cfg/cargo-specifics.html> for more information about checking conditional configuration
    = note: this warning originates in the macro `sel_impl` which comes from the expansion of the macro `msg_send` (in Nightly builds, run with -Z macro-backtrace for more info)

warning: unexpected `cfg` condition value: `cargo-clippy`
   --> src/commands/native_terminal.rs:471:24
    |
471 |         let font: id = msg_send![class!(NSFont), fontWithName: font_name_ns size: 13.0];
    |                        ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
    |
    = note: no expected values for `feature`
    = note: using a cfg inside a macro will use the cfgs from the destination crate and not the ones from the defining crate
    = help: try referring to `sel_impl` crate for guidance on how handle this unexpected cfg
    = help: the macro `sel_impl` may come from an old version of the `objc` crate, try updating your dependency with `cargo update -p objc`
    = note: see <https://doc.rust-lang.org/nightly/rustc/check-cfg/cargo-specifics.html> for more information about checking conditional configuration
    = note: this warning originates in the macro `sel_impl` which comes from the expansion of the macro `msg_send` (in Nightly builds, run with -Z macro-backtrace for more info)

warning: unexpected `cfg` condition value: `cargo-clippy`
   --> src/commands/native_terminal.rs:471:34
    |
471 |         let font: id = msg_send![class!(NSFont), fontWithName: font_name_ns size: 13.0];
    |                                  ^^^^^^^^^^^^^^
    |
    = note: no expected values for `feature`
    = note: using a cfg inside a macro will use the cfgs from the destination crate and not the ones from the defining crate
    = help: try referring to `class` crate for guidance on how handle this unexpected cfg
    = help: the macro `class` may come from an old version of the `objc` crate, try updating your dependency with `cargo update -p objc`
    = note: see <https://doc.rust-lang.org/nightly/rustc/check-cfg/cargo-specifics.html> for more information about checking conditional configuration
    = note: this warning originates in the macro `class` (in Nightly builds, run with -Z macro-backtrace for more info)

warning: unexpected `cfg` condition value: `cargo-clippy`
   --> src/commands/native_terminal.rs:472:33
    |
472 |         let fallback_font: id = msg_send![class!(NSFont), userFixedPitchFontOfSize: 13.0];
    |                                 ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
    |
    = note: no expected values for `feature`
    = note: using a cfg inside a macro will use the cfgs from the destination crate and not the ones from the defining crate
    = help: try referring to `sel_impl` crate for guidance on how handle this unexpected cfg
    = help: the macro `sel_impl` may come from an old version of the `objc` crate, try updating your dependency with `cargo update -p objc`
    = note: see <https://doc.rust-lang.org/nightly/rustc/check-cfg/cargo-specifics.html> for more information about checking conditional configuration
    = note: this warning originates in the macro `sel_impl` which comes from the expansion of the macro `msg_send` (in Nightly builds, run with -Z macro-backtrace for more info)

warning: unexpected `cfg` condition value: `cargo-clippy`
   --> src/commands/native_terminal.rs:472:43
    |
472 |         let fallback_font: id = msg_send![class!(NSFont), userFixedPitchFontOfSize: 13.0];
    |                                           ^^^^^^^^^^^^^^
    |
    = note: no expected values for `feature`
    = note: using a cfg inside a macro will use the cfgs from the destination crate and not the ones from the defining crate
    = help: try referring to `class` crate for guidance on how handle this unexpected cfg
    = help: the macro `class` may come from an old version of the `objc` crate, try updating your dependency with `cargo update -p objc`
    = note: see <https://doc.rust-lang.org/nightly/rustc/check-cfg/cargo-specifics.html> for more information about checking conditional configuration
    = note: this warning originates in the macro `class` (in Nightly builds, run with -Z macro-backtrace for more info)

warning: unexpected `cfg` condition value: `cargo-clippy`
   --> src/commands/native_terminal.rs:475:21
    |
475 |           let _: () = msg_send![
    |  _____________________^
476 | |             attrs,
477 | |             setObject: font_to_use
478 | |             forKey: NSString::alloc(nil).init_str("NSFont")
479 | |         ];
    | |_________^
    |
    = note: no expected values for `feature`
    = note: using a cfg inside a macro will use the cfgs from the destination crate and not the ones from the defining crate
    = help: try referring to `sel_impl` crate for guidance on how handle this unexpected cfg
    = help: the macro `sel_impl` may come from an old version of the `objc` crate, try updating your dependency with `cargo update -p objc`
    = note: see <https://doc.rust-lang.org/nightly/rustc/check-cfg/cargo-specifics.html> for more information about checking conditional configuration
    = note: this warning originates in the macro `sel_impl` which comes from the expansion of the macro `msg_send` (in Nightly builds, run with -Z macro-backtrace for more info)

warning: unexpected `cfg` condition value: `cargo-clippy`
   --> src/commands/native_terminal.rs:480:21
    |
480 |           let _: () = msg_send![
    |  _____________________^
481 | |             attrs,
482 | |             setObject: foreground
483 | |             forKey: NSString::alloc(nil).init_str("NSColor")
484 | |         ];
    | |_________^
    |
    = note: no expected values for `feature`
    = note: using a cfg inside a macro will use the cfgs from the destination crate and not the ones from the defining crate
    = help: try referring to `sel_impl` crate for guidance on how handle this unexpected cfg
    = help: the macro `sel_impl` may come from an old version of the `objc` crate, try updating your dependency with `cargo update -p objc`
    = note: see <https://doc.rust-lang.org/nightly/rustc/check-cfg/cargo-specifics.html> for more information about checking conditional configuration
    = note: this warning originates in the macro `sel_impl` which comes from the expansion of the macro `msg_send` (in Nightly builds, run with -Z macro-backtrace for more info)

warning: unexpected `cfg` condition value: `cargo-clippy`
   --> src/commands/native_terminal.rs:487:25
    |
487 |               let _: () = msg_send![
    |  _________________________^
488 | |                 attrs,
489 | |                 setObject: background
490 | |                 forKey: NSString::alloc(nil).init_str("NSBackgroundColor")
491 | |             ];
    | |_____________^
    |
    = note: no expected values for `feature`
    = note: using a cfg inside a macro will use the cfgs from the destination crate and not the ones from the defining crate
    = help: try referring to `sel_impl` crate for guidance on how handle this unexpected cfg
    = help: the macro `sel_impl` may come from an old version of the `objc` crate, try updating your dependency with `cargo update -p objc`
    = note: see <https://doc.rust-lang.org/nightly/rustc/check-cfg/cargo-specifics.html> for more information about checking conditional configuration
    = note: this warning originates in the macro `sel_impl` which comes from the expansion of the macro `msg_send` (in Nightly builds, run with -Z macro-backtrace for more info)

warning: unexpected `cfg` condition value: `cargo-clippy`
   --> src/commands/native_terminal.rs:494:39
    |
494 |             let underline_style: id = msg_send![class!(NSNumber), numberWithInt: 1i32];
    |                                       ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
    |
    = note: no expected values for `feature`
    = note: using a cfg inside a macro will use the cfgs from the destination crate and not the ones from the defining crate
    = help: try referring to `sel_impl` crate for guidance on how handle this unexpected cfg
    = help: the macro `sel_impl` may come from an old version of the `objc` crate, try updating your dependency with `cargo update -p objc`
    = note: see <https://doc.rust-lang.org/nightly/rustc/check-cfg/cargo-specifics.html> for more information about checking conditional configuration
    = note: this warning originates in the macro `sel_impl` which comes from the expansion of the macro `msg_send` (in Nightly builds, run with -Z macro-backtrace for more info)

warning: unexpected `cfg` condition value: `cargo-clippy`
   --> src/commands/native_terminal.rs:494:49
    |
494 |             let underline_style: id = msg_send![class!(NSNumber), numberWithInt: 1i32];
    |                                                 ^^^^^^^^^^^^^^^^
    |
    = note: no expected values for `feature`
    = note: using a cfg inside a macro will use the cfgs from the destination crate and not the ones from the defining crate
    = help: try referring to `class` crate for guidance on how handle this unexpected cfg
    = help: the macro `class` may come from an old version of the `objc` crate, try updating your dependency with `cargo update -p objc`
    = note: see <https://doc.rust-lang.org/nightly/rustc/check-cfg/cargo-specifics.html> for more information about checking conditional configuration
    = note: this warning originates in the macro `class` (in Nightly builds, run with -Z macro-backtrace for more info)

warning: unexpected `cfg` condition value: `cargo-clippy`
   --> src/commands/native_terminal.rs:495:25
    |
495 |               let _: () = msg_send![
    |  _________________________^
496 | |                 attrs,
497 | |                 setObject: underline_style
498 | |                 forKey: NSString::alloc(nil).init_str("NSUnderline")
499 | |             ];
    | |_____________^
    |
    = note: no expected values for `feature`
    = note: using a cfg inside a macro will use the cfgs from the destination crate and not the ones from the defining crate
    = help: try referring to `sel_impl` crate for guidance on how handle this unexpected cfg
    = help: the macro `sel_impl` may come from an old version of the `objc` crate, try updating your dependency with `cargo update -p objc`
    = note: see <https://doc.rust-lang.org/nightly/rustc/check-cfg/cargo-specifics.html> for more information about checking conditional configuration
    = note: this warning originates in the macro `sel_impl` which comes from the expansion of the macro `msg_send` (in Nightly builds, run with -Z macro-backtrace for more info)

warning: unexpected `cfg` condition value: `cargo-clippy`
   --> src/commands/native_terminal.rs:503:28
    |
503 |         let fragment: id = msg_send![class!(NSAttributedString), alloc];
    |                            ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
    |
    = note: no expected values for `feature`
    = note: using a cfg inside a macro will use the cfgs from the destination crate and not the ones from the defining crate
    = help: try referring to `sel_impl` crate for guidance on how handle this unexpected cfg
    = help: the macro `sel_impl` may come from an old version of the `objc` crate, try updating your dependency with `cargo update -p objc`
    = note: see <https://doc.rust-lang.org/nightly/rustc/check-cfg/cargo-specifics.html> for more information about checking conditional configuration
    = note: this warning originates in the macro `sel_impl` which comes from the expansion of the macro `msg_send` (in Nightly builds, run with -Z macro-backtrace for more info)

warning: unexpected `cfg` condition value: `cargo-clippy`
   --> src/commands/native_terminal.rs:503:38
    |
503 |         let fragment: id = msg_send![class!(NSAttributedString), alloc];
    |                                      ^^^^^^^^^^^^^^^^^^^^^^^^^^
    |
    = note: no expected values for `feature`
    = note: using a cfg inside a macro will use the cfgs from the destination crate and not the ones from the defining crate
    = help: try referring to `class` crate for guidance on how handle this unexpected cfg
    = help: the macro `class` may come from an old version of the `objc` crate, try updating your dependency with `cargo update -p objc`
    = note: see <https://doc.rust-lang.org/nightly/rustc/check-cfg/cargo-specifics.html> for more information about checking conditional configuration
    = note: this warning originates in the macro `class` (in Nightly builds, run with -Z macro-backtrace for more info)

warning: unexpected `cfg` condition value: `cargo-clippy`
   --> src/commands/native_terminal.rs:504:28
    |
504 |         let fragment: id = msg_send![fragment, initWithString: ns_text attributes: attrs];
    |                            ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
    |
    = note: no expected values for `feature`
    = note: using a cfg inside a macro will use the cfgs from the destination crate and not the ones from the defining crate
    = help: try referring to `sel_impl` crate for guidance on how handle this unexpected cfg
    = help: the macro `sel_impl` may come from an old version of the `objc` crate, try updating your dependency with `cargo update -p objc`
    = note: see <https://doc.rust-lang.org/nightly/rustc/check-cfg/cargo-specifics.html> for more information about checking conditional configuration
    = note: this warning originates in the macro `sel_impl` which comes from the expansion of the macro `msg_send` (in Nightly builds, run with -Z macro-backtrace for more info)

warning: unexpected `cfg` condition value: `cargo-clippy`
   --> src/commands/native_terminal.rs:505:21
    |
505 |         let _: () = msg_send![mutable, appendAttributedString: fragment];
    |                     ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
    |
    = note: no expected values for `feature`
    = note: using a cfg inside a macro will use the cfgs from the destination crate and not the ones from the defining crate
    = help: try referring to `sel_impl` crate for guidance on how handle this unexpected cfg
    = help: the macro `sel_impl` may come from an old version of the `objc` crate, try updating your dependency with `cargo update -p objc`
    = note: see <https://doc.rust-lang.org/nightly/rustc/check-cfg/cargo-specifics.html> for more information about checking conditional configuration
    = note: this warning originates in the macro `sel_impl` which comes from the expansion of the macro `msg_send` (in Nightly builds, run with -Z macro-backtrace for more info)

warning: unexpected `cfg` condition value: `cargo-clippy`
   --> src/commands/native_terminal.rs:511:27
    |
511 |         let mutable: id = msg_send![class!(NSMutableAttributedString), alloc];
    |                           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
    |
    = note: no expected values for `feature`
    = note: using a cfg inside a macro will use the cfgs from the destination crate and not the ones from the defining crate
    = help: try referring to `sel_impl` crate for guidance on how handle this unexpected cfg
    = help: the macro `sel_impl` may come from an old version of the `objc` crate, try updating your dependency with `cargo update -p objc`
    = note: see <https://doc.rust-lang.org/nightly/rustc/check-cfg/cargo-specifics.html> for more information about checking conditional configuration
    = note: this warning originates in the macro `sel_impl` which comes from the expansion of the macro `msg_send` (in Nightly builds, run with -Z macro-backtrace for more info)

warning: unexpected `cfg` condition value: `cargo-clippy`
   --> src/commands/native_terminal.rs:511:37
    |
511 |         let mutable: id = msg_send![class!(NSMutableAttributedString), alloc];
    |                                     ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
    |
    = note: no expected values for `feature`
    = note: using a cfg inside a macro will use the cfgs from the destination crate and not the ones from the defining crate
    = help: try referring to `class` crate for guidance on how handle this unexpected cfg
    = help: the macro `class` may come from an old version of the `objc` crate, try updating your dependency with `cargo update -p objc`
    = note: see <https://doc.rust-lang.org/nightly/rustc/check-cfg/cargo-specifics.html> for more information about checking conditional configuration
    = note: this warning originates in the macro `class` (in Nightly builds, run with -Z macro-backtrace for more info)

warning: unexpected `cfg` condition value: `cargo-clippy`
   --> src/commands/native_terminal.rs:512:27
    |
512 |         let mutable: id = msg_send![mutable, init];
    |                           ^^^^^^^^^^^^^^^^^^^^^^^^
    |
    = note: no expected values for `feature`
    = note: using a cfg inside a macro will use the cfgs from the destination crate and not the ones from the defining crate
    = help: try referring to `sel_impl` crate for guidance on how handle this unexpected cfg
    = help: the macro `sel_impl` may come from an old version of the `objc` crate, try updating your dependency with `cargo update -p objc`
    = note: see <https://doc.rust-lang.org/nightly/rustc/check-cfg/cargo-specifics.html> for more information about checking conditional configuration
    = note: this warning originates in the macro `sel_impl` which comes from the expansion of the macro `msg_send` (in Nightly builds, run with -Z macro-backtrace for more info)

warning: unexpected `cfg` condition value: `cargo-clippy`
   --> src/commands/native_terminal.rs:568:34
    |
568 |         let text_container: id = msg_send![text_view, textContainer];
    |                                  ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
    |
    = note: no expected values for `feature`
    = note: using a cfg inside a macro will use the cfgs from the destination crate and not the ones from the defining crate
    = help: try referring to `sel_impl` crate for guidance on how handle this unexpected cfg
    = help: the macro `sel_impl` may come from an old version of the `objc` crate, try updating your dependency with `cargo update -p objc`
    = note: see <https://doc.rust-lang.org/nightly/rustc/check-cfg/cargo-specifics.html> for more information about checking conditional configuration
    = note: this warning originates in the macro `sel_impl` which comes from the expansion of the macro `msg_send` (in Nightly builds, run with -Z macro-backtrace for more info)

warning: unexpected `cfg` condition value: `cargo-clippy`
   --> src/commands/native_terminal.rs:569:21
    |
569 |         let _: () = msg_send![text_container, setContainerSize: NSSize::new(width.max(1.0), f64::MAX)];
    |                     ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
    |
    = note: no expected values for `feature`
    = note: using a cfg inside a macro will use the cfgs from the destination crate and not the ones from the defining crate
    = help: try referring to `sel_impl` crate for guidance on how handle this unexpected cfg
    = help: the macro `sel_impl` may come from an old version of the `objc` crate, try updating your dependency with `cargo update -p objc`
    = note: see <https://doc.rust-lang.org/nightly/rustc/check-cfg/cargo-specifics.html> for more information about checking conditional configuration
    = note: this warning originates in the macro `sel_impl` which comes from the expansion of the macro `msg_send` (in Nightly builds, run with -Z macro-backtrace for more info)

warning: unexpected `cfg` condition value: `cargo-clippy`
   --> src/commands/native_terminal.rs:570:21
    |
570 |         let _: () = msg_send![text_container, setWidthTracksTextView: YES];
    |                     ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
    |
    = note: no expected values for `feature`
    = note: using a cfg inside a macro will use the cfgs from the destination crate and not the ones from the defining crate
    = help: try referring to `sel_impl` crate for guidance on how handle this unexpected cfg
    = help: the macro `sel_impl` may come from an old version of the `objc` crate, try updating your dependency with `cargo update -p objc`
    = note: see <https://doc.rust-lang.org/nightly/rustc/check-cfg/cargo-specifics.html> for more information about checking conditional configuration
    = note: this warning originates in the macro `sel_impl` which comes from the expansion of the macro `msg_send` (in Nightly builds, run with -Z macro-backtrace for more info)

warning: unexpected `cfg` condition value: `cargo-clippy`
   --> src/commands/native_terminal.rs:591:35
    |
591 |         let root_bounds: NSRect = msg_send![ns_view, bounds];
    |                                   ^^^^^^^^^^^^^^^^^^^^^^^^^^
    |
    = note: no expected values for `feature`
    = note: using a cfg inside a macro will use the cfgs from the destination crate and not the ones from the defining crate
    = help: try referring to `sel_impl` crate for guidance on how handle this unexpected cfg
    = help: the macro `sel_impl` may come from an old version of the `objc` crate, try updating your dependency with `cargo update -p objc`
    = note: see <https://doc.rust-lang.org/nightly/rustc/check-cfg/cargo-specifics.html> for more information about checking conditional configuration
    = note: this warning originates in the macro `sel_impl` which comes from the expansion of the macro `msg_send` (in Nightly builds, run with -Z macro-backtrace for more info)

warning: unexpected `cfg` condition value: `cargo-clippy`
   --> src/commands/native_terminal.rs:604:25
    |
604 |             let _: () = msg_send![host_view, setHidden: if visible && width > 0.0 && height > 0.0 { NO } else { YES }];
    |                         ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
    |
    = note: no expected values for `feature`
    = note: using a cfg inside a macro will use the cfgs from the destination crate and not the ones from the defining crate
    = help: try referring to `sel_impl` crate for guidance on how handle this unexpected cfg
    = help: the macro `sel_impl` may come from an old version of the `objc` crate, try updating your dependency with `cargo update -p objc`
    = note: see <https://doc.rust-lang.org/nightly/rustc/check-cfg/cargo-specifics.html> for more information about checking conditional configuration
    = note: this warning originates in the macro `sel_impl` which comes from the expansion of the macro `msg_send` (in Nightly builds, run with -Z macro-backtrace for more info)

warning: unexpected `cfg` condition value: `cargo-clippy`
   --> src/commands/native_terminal.rs:605:25
    |
605 |             let _: () = msg_send![host_view, setFrame: frame];
    |                         ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
    |
    = note: no expected values for `feature`
    = note: using a cfg inside a macro will use the cfgs from the destination crate and not the ones from the defining crate
    = help: try referring to `sel_impl` crate for guidance on how handle this unexpected cfg
    = help: the macro `sel_impl` may come from an old version of the `objc` crate, try updating your dependency with `cargo update -p objc`
    = note: see <https://doc.rust-lang.org/nightly/rustc/check-cfg/cargo-specifics.html> for more information about checking conditional configuration
    = note: this warning originates in the macro `sel_impl` which comes from the expansion of the macro `msg_send` (in Nightly builds, run with -Z macro-backtrace for more info)

warning: unexpected `cfg` condition value: `cargo-clippy`
   --> src/commands/native_terminal.rs:606:25
    |
606 |             let _: () = msg_send![scroll_view, setFrame: inner_frame];
    |                         ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
    |
    = note: no expected values for `feature`
    = note: using a cfg inside a macro will use the cfgs from the destination crate and not the ones from the defining crate
    = help: try referring to `sel_impl` crate for guidance on how handle this unexpected cfg
    = help: the macro `sel_impl` may come from an old version of the `objc` crate, try updating your dependency with `cargo update -p objc`
    = note: see <https://doc.rust-lang.org/nightly/rustc/check-cfg/cargo-specifics.html> for more information about checking conditional configuration
    = note: this warning originates in the macro `sel_impl` which comes from the expansion of the macro `msg_send` (in Nightly builds, run with -Z macro-backtrace for more info)

warning: unexpected `cfg` condition value: `cargo-clippy`
   --> src/commands/native_terminal.rs:607:25
    |
607 |             let _: () = msg_send![text_view, setFrame: inner_frame];
    |                         ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
    |
    = note: no expected values for `feature`
    = note: using a cfg inside a macro will use the cfgs from the destination crate and not the ones from the defining crate
    = help: try referring to `sel_impl` crate for guidance on how handle this unexpected cfg
    = help: the macro `sel_impl` may come from an old version of the `objc` crate, try updating your dependency with `cargo update -p objc`
    = note: see <https://doc.rust-lang.org/nightly/rustc/check-cfg/cargo-specifics.html> for more information about checking conditional configuration
    = note: this warning originates in the macro `sel_impl` which comes from the expansion of the macro `msg_send` (in Nightly builds, run with -Z macro-backtrace for more info)

warning: unexpected `cfg` condition value: `cargo-clippy`
   --> src/commands/native_terminal.rs:614:29
    |
614 |         let host_view: id = msg_send![host_class, alloc];
    |                             ^^^^^^^^^^^^^^^^^^^^^^^^^^^^
    |
    = note: no expected values for `feature`
    = note: using a cfg inside a macro will use the cfgs from the destination crate and not the ones from the defining crate
    = help: try referring to `sel_impl` crate for guidance on how handle this unexpected cfg
    = help: the macro `sel_impl` may come from an old version of the `objc` crate, try updating your dependency with `cargo update -p objc`
    = note: see <https://doc.rust-lang.org/nightly/rustc/check-cfg/cargo-specifics.html> for more information about checking conditional configuration
    = note: this warning originates in the macro `sel_impl` which comes from the expansion of the macro `msg_send` (in Nightly builds, run with -Z macro-backtrace for more info)

warning: unexpected `cfg` condition value: `cargo-clippy`
   --> src/commands/native_terminal.rs:615:29
    |
615 |         let host_view: id = msg_send![host_view, initWithFrame: frame];
    |                             ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
    |
    = note: no expected values for `feature`
    = note: using a cfg inside a macro will use the cfgs from the destination crate and not the ones from the defining crate
    = help: try referring to `sel_impl` crate for guidance on how handle this unexpected cfg
    = help: the macro `sel_impl` may come from an old version of the `objc` crate, try updating your dependency with `cargo update -p objc`
    = note: see <https://doc.rust-lang.org/nightly/rustc/check-cfg/cargo-specifics.html> for more information about checking conditional configuration
    = note: this warning originates in the macro `sel_impl` which comes from the expansion of the macro `msg_send` (in Nightly builds, run with -Z macro-backtrace for more info)

warning: unexpected `cfg` condition value: `cargo-clippy`
   --> src/commands/native_terminal.rs:616:21
    |
616 |         let _: () = msg_send![host_view, setHidden: if visible && width > 0.0 && height > 0.0 { NO } else { YES }];
    |                     ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
    |
    = note: no expected values for `feature`
    = note: using a cfg inside a macro will use the cfgs from the destination crate and not the ones from the defining crate
    = help: try referring to `sel_impl` crate for guidance on how handle this unexpected cfg
    = help: the macro `sel_impl` may come from an old version of the `objc` crate, try updating your dependency with `cargo update -p objc`
    = note: see <https://doc.rust-lang.org/nightly/rustc/check-cfg/cargo-specifics.html> for more information about checking conditional configuration
    = note: this warning originates in the macro `sel_impl` which comes from the expansion of the macro `msg_send` (in Nightly builds, run with -Z macro-backtrace for more info)

warning: unexpected `cfg` condition value: `cargo-clippy`
   --> src/commands/native_terminal.rs:617:21
    |
617 |         let _: () = msg_send![host_view, setWantsLayer: YES];
    |                     ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
    |
    = note: no expected values for `feature`
    = note: using a cfg inside a macro will use the cfgs from the destination crate and not the ones from the defining crate
    = help: try referring to `sel_impl` crate for guidance on how handle this unexpected cfg
    = help: the macro `sel_impl` may come from an old version of the `objc` crate, try updating your dependency with `cargo update -p objc`
    = note: see <https://doc.rust-lang.org/nightly/rustc/check-cfg/cargo-specifics.html> for more information about checking conditional configuration
    = note: this warning originates in the macro `sel_impl` which comes from the expansion of the macro `msg_send` (in Nightly builds, run with -Z macro-backtrace for more info)

warning: unexpected `cfg` condition value: `cargo-clippy`
   --> src/commands/native_terminal.rs:619:31
    |
619 |         let scroll_view: id = msg_send![class!(NSScrollView), alloc];
    |                               ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
    |
    = note: no expected values for `feature`
    = note: using a cfg inside a macro will use the cfgs from the destination crate and not the ones from the defining crate
    = help: try referring to `sel_impl` crate for guidance on how handle this unexpected cfg
    = help: the macro `sel_impl` may come from an old version of the `objc` crate, try updating your dependency with `cargo update -p objc`
    = note: see <https://doc.rust-lang.org/nightly/rustc/check-cfg/cargo-specifics.html> for more information about checking conditional configuration
    = note: this warning originates in the macro `sel_impl` which comes from the expansion of the macro `msg_send` (in Nightly builds, run with -Z macro-backtrace for more info)

warning: unexpected `cfg` condition value: `cargo-clippy`
   --> src/commands/native_terminal.rs:619:41
    |
619 |         let scroll_view: id = msg_send![class!(NSScrollView), alloc];
    |                                         ^^^^^^^^^^^^^^^^^^^^
    |
    = note: no expected values for `feature`
    = note: using a cfg inside a macro will use the cfgs from the destination crate and not the ones from the defining crate
    = help: try referring to `class` crate for guidance on how handle this unexpected cfg
    = help: the macro `class` may come from an old version of the `objc` crate, try updating your dependency with `cargo update -p objc`
    = note: see <https://doc.rust-lang.org/nightly/rustc/check-cfg/cargo-specifics.html> for more information about checking conditional configuration
    = note: this warning originates in the macro `class` (in Nightly builds, run with -Z macro-backtrace for more info)

warning: unexpected `cfg` condition value: `cargo-clippy`
   --> src/commands/native_terminal.rs:620:31
    |
620 |         let scroll_view: id = msg_send![scroll_view, initWithFrame: inner_frame];
    |                               ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
    |
    = note: no expected values for `feature`
    = note: using a cfg inside a macro will use the cfgs from the destination crate and not the ones from the defining crate
    = help: try referring to `sel_impl` crate for guidance on how handle this unexpected cfg
    = help: the macro `sel_impl` may come from an old version of the `objc` crate, try updating your dependency with `cargo update -p objc`
    = note: see <https://doc.rust-lang.org/nightly/rustc/check-cfg/cargo-specifics.html> for more information about checking conditional configuration
    = note: this warning originates in the macro `sel_impl` which comes from the expansion of the macro `msg_send` (in Nightly builds, run with -Z macro-backtrace for more info)

warning: unexpected `cfg` condition value: `cargo-clippy`
   --> src/commands/native_terminal.rs:621:21
    |
621 |         let _: () = msg_send![scroll_view, setHasVerticalScroller: YES];
    |                     ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
    |
    = note: no expected values for `feature`
    = note: using a cfg inside a macro will use the cfgs from the destination crate and not the ones from the defining crate
    = help: try referring to `sel_impl` crate for guidance on how handle this unexpected cfg
    = help: the macro `sel_impl` may come from an old version of the `objc` crate, try updating your dependency with `cargo update -p objc`
    = note: see <https://doc.rust-lang.org/nightly/rustc/check-cfg/cargo-specifics.html> for more information about checking conditional configuration
    = note: this warning originates in the macro `sel_impl` which comes from the expansion of the macro `msg_send` (in Nightly builds, run with -Z macro-backtrace for more info)

warning: unexpected `cfg` condition value: `cargo-clippy`
   --> src/commands/native_terminal.rs:622:21
    |
622 |         let _: () = msg_send![scroll_view, setHasHorizontalScroller: NO];
    |                     ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
    |
    = note: no expected values for `feature`
    = note: using a cfg inside a macro will use the cfgs from the destination crate and not the ones from the defining crate
    = help: try referring to `sel_impl` crate for guidance on how handle this unexpected cfg
    = help: the macro `sel_impl` may come from an old version of the `objc` crate, try updating your dependency with `cargo update -p objc`
    = note: see <https://doc.rust-lang.org/nightly/rustc/check-cfg/cargo-specifics.html> for more information about checking conditional configuration
    = note: this warning originates in the macro `sel_impl` which comes from the expansion of the macro `msg_send` (in Nightly builds, run with -Z macro-backtrace for more info)

warning: unexpected `cfg` condition value: `cargo-clippy`
   --> src/commands/native_terminal.rs:623:21
    |
623 |         let _: () = msg_send![scroll_view, setAutohidesScrollers: YES];
    |                     ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
    |
    = note: no expected values for `feature`
    = note: using a cfg inside a macro will use the cfgs from the destination crate and not the ones from the defining crate
    = help: try referring to `sel_impl` crate for guidance on how handle this unexpected cfg
    = help: the macro `sel_impl` may come from an old version of the `objc` crate, try updating your dependency with `cargo update -p objc`
    = note: see <https://doc.rust-lang.org/nightly/rustc/check-cfg/cargo-specifics.html> for more information about checking conditional configuration
    = note: this warning originates in the macro `sel_impl` which comes from the expansion of the macro `msg_send` (in Nightly builds, run with -Z macro-backtrace for more info)

warning: unexpected `cfg` condition value: `cargo-clippy`
   --> src/commands/native_terminal.rs:624:21
    |
624 |         let _: () = msg_send![scroll_view, setBorderType: 0usize];
    |                     ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
    |
    = note: no expected values for `feature`
    = note: using a cfg inside a macro will use the cfgs from the destination crate and not the ones from the defining crate
    = help: try referring to `sel_impl` crate for guidance on how handle this unexpected cfg
    = help: the macro `sel_impl` may come from an old version of the `objc` crate, try updating your dependency with `cargo update -p objc`
    = note: see <https://doc.rust-lang.org/nightly/rustc/check-cfg/cargo-specifics.html> for more information about checking conditional configuration
    = note: this warning originates in the macro `sel_impl` which comes from the expansion of the macro `msg_send` (in Nightly builds, run with -Z macro-backtrace for more info)

warning: unexpected `cfg` condition value: `cargo-clippy`
   --> src/commands/native_terminal.rs:625:21
    |
625 |         let _: () = msg_send![scroll_view, setDrawsBackground: NO];
    |                     ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
    |
    = note: no expected values for `feature`
    = note: using a cfg inside a macro will use the cfgs from the destination crate and not the ones from the defining crate
    = help: try referring to `sel_impl` crate for guidance on how handle this unexpected cfg
    = help: the macro `sel_impl` may come from an old version of the `objc` crate, try updating your dependency with `cargo update -p objc`
    = note: see <https://doc.rust-lang.org/nightly/rustc/check-cfg/cargo-specifics.html> for more information about checking conditional configuration
    = note: this warning originates in the macro `sel_impl` which comes from the expansion of the macro `msg_send` (in Nightly builds, run with -Z macro-backtrace for more info)

warning: unexpected `cfg` condition value: `cargo-clippy`
   --> src/commands/native_terminal.rs:628:29
    |
628 |         let text_view: id = msg_send![text_view_class, alloc];
    |                             ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
    |
    = note: no expected values for `feature`
    = note: using a cfg inside a macro will use the cfgs from the destination crate and not the ones from the defining crate
    = help: try referring to `sel_impl` crate for guidance on how handle this unexpected cfg
    = help: the macro `sel_impl` may come from an old version of the `objc` crate, try updating your dependency with `cargo update -p objc`
    = note: see <https://doc.rust-lang.org/nightly/rustc/check-cfg/cargo-specifics.html> for more information about checking conditional configuration
    = note: this warning originates in the macro `sel_impl` which comes from the expansion of the macro `msg_send` (in Nightly builds, run with -Z macro-backtrace for more info)

warning: unexpected `cfg` condition value: `cargo-clippy`
   --> src/commands/native_terminal.rs:629:29
    |
629 |         let text_view: id = msg_send![text_view, initWithFrame: inner_frame];
    |                             ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
    |
    = note: no expected values for `feature`
    = note: using a cfg inside a macro will use the cfgs from the destination crate and not the ones from the defining crate
    = help: try referring to `sel_impl` crate for guidance on how handle this unexpected cfg
    = help: the macro `sel_impl` may come from an old version of the `objc` crate, try updating your dependency with `cargo update -p objc`
    = note: see <https://doc.rust-lang.org/nightly/rustc/check-cfg/cargo-specifics.html> for more information about checking conditional configuration
    = note: this warning originates in the macro `sel_impl` which comes from the expansion of the macro `msg_send` (in Nightly builds, run with -Z macro-backtrace for more info)

warning: unexpected `cfg` condition value: `cargo-clippy`
   --> src/commands/native_terminal.rs:630:21
    |
630 |         let _: () = msg_send![text_view, setEditable: NO];
    |                     ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
    |
    = note: no expected values for `feature`
    = note: using a cfg inside a macro will use the cfgs from the destination crate and not the ones from the defining crate
    = help: try referring to `sel_impl` crate for guidance on how handle this unexpected cfg
    = help: the macro `sel_impl` may come from an old version of the `objc` crate, try updating your dependency with `cargo update -p objc`
    = note: see <https://doc.rust-lang.org/nightly/rustc/check-cfg/cargo-specifics.html> for more information about checking conditional configuration
    = note: this warning originates in the macro `sel_impl` which comes from the expansion of the macro `msg_send` (in Nightly builds, run with -Z macro-backtrace for more info)

warning: unexpected `cfg` condition value: `cargo-clippy`
   --> src/commands/native_terminal.rs:631:21
    |
631 |         let _: () = msg_send![text_view, setSelectable: YES];
    |                     ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
    |
    = note: no expected values for `feature`
    = note: using a cfg inside a macro will use the cfgs from the destination crate and not the ones from the defining crate
    = help: try referring to `sel_impl` crate for guidance on how handle this unexpected cfg
    = help: the macro `sel_impl` may come from an old version of the `objc` crate, try updating your dependency with `cargo update -p objc`
    = note: see <https://doc.rust-lang.org/nightly/rustc/check-cfg/cargo-specifics.html> for more information about checking conditional configuration
    = note: this warning originates in the macro `sel_impl` which comes from the expansion of the macro `msg_send` (in Nightly builds, run with -Z macro-backtrace for more info)

warning: unexpected `cfg` condition value: `cargo-clippy`
   --> src/commands/native_terminal.rs:632:21
    |
632 |         let _: () = msg_send![text_view, setRichText: YES];
    |                     ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
    |
    = note: no expected values for `feature`
    = note: using a cfg inside a macro will use the cfgs from the destination crate and not the ones from the defining crate
    = help: try referring to `sel_impl` crate for guidance on how handle this unexpected cfg
    = help: the macro `sel_impl` may come from an old version of the `objc` crate, try updating your dependency with `cargo update -p objc`
    = note: see <https://doc.rust-lang.org/nightly/rustc/check-cfg/cargo-specifics.html> for more information about checking conditional configuration
    = note: this warning originates in the macro `sel_impl` which comes from the expansion of the macro `msg_send` (in Nightly builds, run with -Z macro-backtrace for more info)

warning: unexpected `cfg` condition value: `cargo-clippy`
   --> src/commands/native_terminal.rs:633:21
    |
633 |         let _: () = msg_send![text_view, setImportsGraphics: NO];
    |                     ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
    |
    = note: no expected values for `feature`
    = note: using a cfg inside a macro will use the cfgs from the destination crate and not the ones from the defining crate
    = help: try referring to `sel_impl` crate for guidance on how handle this unexpected cfg
    = help: the macro `sel_impl` may come from an old version of the `objc` crate, try updating your dependency with `cargo update -p objc`
    = note: see <https://doc.rust-lang.org/nightly/rustc/check-cfg/cargo-specifics.html> for more information about checking conditional configuration
    = note: this warning originates in the macro `sel_impl` which comes from the expansion of the macro `msg_send` (in Nightly builds, run with -Z macro-backtrace for more info)

warning: unexpected `cfg` condition value: `cargo-clippy`
   --> src/commands/native_terminal.rs:634:21
    |
634 |         let _: () = msg_send![text_view, setUsesFindPanel: YES];
    |                     ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
    |
    = note: no expected values for `feature`
    = note: using a cfg inside a macro will use the cfgs from the destination crate and not the ones from the defining crate
    = help: try referring to `sel_impl` crate for guidance on how handle this unexpected cfg
    = help: the macro `sel_impl` may come from an old version of the `objc` crate, try updating your dependency with `cargo update -p objc`
    = note: see <https://doc.rust-lang.org/nightly/rustc/check-cfg/cargo-specifics.html> for more information about checking conditional configuration
    = note: this warning originates in the macro `sel_impl` which comes from the expansion of the macro `msg_send` (in Nightly builds, run with -Z macro-backtrace for more info)

warning: unexpected `cfg` condition value: `cargo-clippy`
   --> src/commands/native_terminal.rs:635:21
    |
635 |         let _: () = msg_send![text_view, setAutomaticQuoteSubstitutionEnabled: NO];
    |                     ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
    |
    = note: no expected values for `feature`
    = note: using a cfg inside a macro will use the cfgs from the destination crate and not the ones from the defining crate
    = help: try referring to `sel_impl` crate for guidance on how handle this unexpected cfg
    = help: the macro `sel_impl` may come from an old version of the `objc` crate, try updating your dependency with `cargo update -p objc`
    = note: see <https://doc.rust-lang.org/nightly/rustc/check-cfg/cargo-specifics.html> for more information about checking conditional configuration
    = note: this warning originates in the macro `sel_impl` which comes from the expansion of the macro `msg_send` (in Nightly builds, run with -Z macro-backtrace for more info)

warning: unexpected `cfg` condition value: `cargo-clippy`
   --> src/commands/native_terminal.rs:636:21
    |
636 |         let _: () = msg_send![text_view, setAutomaticDashSubstitutionEnabled: NO];
    |                     ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
    |
    = note: no expected values for `feature`
    = note: using a cfg inside a macro will use the cfgs from the destination crate and not the ones from the defining crate
    = help: try referring to `sel_impl` crate for guidance on how handle this unexpected cfg
    = help: the macro `sel_impl` may come from an old version of the `objc` crate, try updating your dependency with `cargo update -p objc`
    = note: see <https://doc.rust-lang.org/nightly/rustc/check-cfg/cargo-specifics.html> for more information about checking conditional configuration
    = note: this warning originates in the macro `sel_impl` which comes from the expansion of the macro `msg_send` (in Nightly builds, run with -Z macro-backtrace for more info)

warning: unexpected `cfg` condition value: `cargo-clippy`
   --> src/commands/native_terminal.rs:637:21
    |
637 |         let _: () = msg_send![text_view, setAutomaticTextReplacementEnabled: NO];
    |                     ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
    |
    = note: no expected values for `feature`
    = note: using a cfg inside a macro will use the cfgs from the destination crate and not the ones from the defining crate
    = help: try referring to `sel_impl` crate for guidance on how handle this unexpected cfg
    = help: the macro `sel_impl` may come from an old version of the `objc` crate, try updating your dependency with `cargo update -p objc`
    = note: see <https://doc.rust-lang.org/nightly/rustc/check-cfg/cargo-specifics.html> for more information about checking conditional configuration
    = note: this warning originates in the macro `sel_impl` which comes from the expansion of the macro `msg_send` (in Nightly builds, run with -Z macro-backtrace for more info)

warning: unexpected `cfg` condition value: `cargo-clippy`
   --> src/commands/native_terminal.rs:638:21
    |
638 |         let _: () = msg_send![text_view, setHorizontallyResizable: NO];
    |                     ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
    |
    = note: no expected values for `feature`
    = note: using a cfg inside a macro will use the cfgs from the destination crate and not the ones from the defining crate
    = help: try referring to `sel_impl` crate for guidance on how handle this unexpected cfg
    = help: the macro `sel_impl` may come from an old version of the `objc` crate, try updating your dependency with `cargo update -p objc`
    = note: see <https://doc.rust-lang.org/nightly/rustc/check-cfg/cargo-specifics.html> for more information about checking conditional configuration
    = note: this warning originates in the macro `sel_impl` which comes from the expansion of the macro `msg_send` (in Nightly builds, run with -Z macro-backtrace for more info)

warning: unexpected `cfg` condition value: `cargo-clippy`
   --> src/commands/native_terminal.rs:639:21
    |
639 |         let _: () = msg_send![text_view, setVerticallyResizable: YES];
    |                     ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
    |
    = note: no expected values for `feature`
    = note: using a cfg inside a macro will use the cfgs from the destination crate and not the ones from the defining crate
    = help: try referring to `sel_impl` crate for guidance on how handle this unexpected cfg
    = help: the macro `sel_impl` may come from an old version of the `objc` crate, try updating your dependency with `cargo update -p objc`
    = note: see <https://doc.rust-lang.org/nightly/rustc/check-cfg/cargo-specifics.html> for more information about checking conditional configuration
    = note: this warning originates in the macro `sel_impl` which comes from the expansion of the macro `msg_send` (in Nightly builds, run with -Z macro-backtrace for more info)

warning: unexpected `cfg` condition value: `cargo-clippy`
   --> src/commands/native_terminal.rs:640:24
    |
640 |         let font: id = msg_send![class!(NSFont), userFixedPitchFontOfSize: 13.0];
    |                        ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
    |
    = note: no expected values for `feature`
    = note: using a cfg inside a macro will use the cfgs from the destination crate and not the ones from the defining crate
    = help: try referring to `sel_impl` crate for guidance on how handle this unexpected cfg
    = help: the macro `sel_impl` may come from an old version of the `objc` crate, try updating your dependency with `cargo update -p objc`
    = note: see <https://doc.rust-lang.org/nightly/rustc/check-cfg/cargo-specifics.html> for more information about checking conditional configuration
    = note: this warning originates in the macro `sel_impl` which comes from the expansion of the macro `msg_send` (in Nightly builds, run with -Z macro-backtrace for more info)

warning: unexpected `cfg` condition value: `cargo-clippy`
   --> src/commands/native_terminal.rs:640:34
    |
640 |         let font: id = msg_send![class!(NSFont), userFixedPitchFontOfSize: 13.0];
    |                                  ^^^^^^^^^^^^^^
    |
    = note: no expected values for `feature`
    = note: using a cfg inside a macro will use the cfgs from the destination crate and not the ones from the defining crate
    = help: try referring to `class` crate for guidance on how handle this unexpected cfg
    = help: the macro `class` may come from an old version of the `objc` crate, try updating your dependency with `cargo update -p objc`
    = note: see <https://doc.rust-lang.org/nightly/rustc/check-cfg/cargo-specifics.html> for more information about checking conditional configuration
    = note: this warning originates in the macro `class` (in Nightly builds, run with -Z macro-backtrace for more info)

warning: unexpected `cfg` condition value: `cargo-clippy`
   --> src/commands/native_terminal.rs:641:21
    |
641 |         let _: () = msg_send![text_view, setFont: font];
    |                     ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
    |
    = note: no expected values for `feature`
    = note: using a cfg inside a macro will use the cfgs from the destination crate and not the ones from the defining crate
    = help: try referring to `sel_impl` crate for guidance on how handle this unexpected cfg
    = help: the macro `sel_impl` may come from an old version of the `objc` crate, try updating your dependency with `cargo update -p objc`
    = note: see <https://doc.rust-lang.org/nightly/rustc/check-cfg/cargo-specifics.html> for more information about checking conditional configuration
    = note: this warning originates in the macro `sel_impl` which comes from the expansion of the macro `msg_send` (in Nightly builds, run with -Z macro-backtrace for more info)

warning: unexpected `cfg` condition value: `cargo-clippy`
   --> src/commands/native_terminal.rs:644:21
    |
644 |         let _: () = msg_send![text_view, setBackgroundColor: background];
    |                     ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
    |
    = note: no expected values for `feature`
    = note: using a cfg inside a macro will use the cfgs from the destination crate and not the ones from the defining crate
    = help: try referring to `sel_impl` crate for guidance on how handle this unexpected cfg
    = help: the macro `sel_impl` may come from an old version of the `objc` crate, try updating your dependency with `cargo update -p objc`
    = note: see <https://doc.rust-lang.org/nightly/rustc/check-cfg/cargo-specifics.html> for more information about checking conditional configuration
    = note: this warning originates in the macro `sel_impl` which comes from the expansion of the macro `msg_send` (in Nightly builds, run with -Z macro-backtrace for more info)

warning: unexpected `cfg` condition value: `cargo-clippy`
   --> src/commands/native_terminal.rs:645:21
    |
645 |         let _: () = msg_send![text_view, setTextColor: foreground];
    |                     ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
    |
    = note: no expected values for `feature`
    = note: using a cfg inside a macro will use the cfgs from the destination crate and not the ones from the defining crate
    = help: try referring to `sel_impl` crate for guidance on how handle this unexpected cfg
    = help: the macro `sel_impl` may come from an old version of the `objc` crate, try updating your dependency with `cargo update -p objc`
    = note: see <https://doc.rust-lang.org/nightly/rustc/check-cfg/cargo-specifics.html> for more information about checking conditional configuration
    = note: this warning originates in the macro `sel_impl` which comes from the expansion of the macro `msg_send` (in Nightly builds, run with -Z macro-backtrace for more info)

warning: unexpected `cfg` condition value: `cargo-clippy`
   --> src/commands/native_terminal.rs:646:21
    |
646 |         let _: () = msg_send![text_view, setInsertionPointColor: foreground];
    |                     ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
    |
    = note: no expected values for `feature`
    = note: using a cfg inside a macro will use the cfgs from the destination crate and not the ones from the defining crate
    = help: try referring to `sel_impl` crate for guidance on how handle this unexpected cfg
    = help: the macro `sel_impl` may come from an old version of the `objc` crate, try updating your dependency with `cargo update -p objc`
    = note: see <https://doc.rust-lang.org/nightly/rustc/check-cfg/cargo-specifics.html> for more information about checking conditional configuration
    = note: this warning originates in the macro `sel_impl` which comes from the expansion of the macro `msg_send` (in Nightly builds, run with -Z macro-backtrace for more info)

warning: unexpected `cfg` condition value: `cargo-clippy`
   --> src/commands/native_terminal.rs:647:21
    |
647 |         let _: () = msg_send![text_view, setString: NSString::alloc(nil).init_str("")];
    |                     ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
    |
    = note: no expected values for `feature`
    = note: using a cfg inside a macro will use the cfgs from the destination crate and not the ones from the defining crate
    = help: try referring to `sel_impl` crate for guidance on how handle this unexpected cfg
    = help: the macro `sel_impl` may come from an old version of the `objc` crate, try updating your dependency with `cargo update -p objc`
    = note: see <https://doc.rust-lang.org/nightly/rustc/check-cfg/cargo-specifics.html> for more information about checking conditional configuration
    = note: this warning originates in the macro `sel_impl` which comes from the expansion of the macro `msg_send` (in Nightly builds, run with -Z macro-backtrace for more info)

warning: unexpected `cfg` condition value: `cargo-clippy`
   --> src/commands/native_terminal.rs:650:21
    |
650 |         let _: () = msg_send![scroll_view, setDocumentView: text_view];
    |                     ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
    |
    = note: no expected values for `feature`
    = note: using a cfg inside a macro will use the cfgs from the destination crate and not the ones from the defining crate
    = help: try referring to `sel_impl` crate for guidance on how handle this unexpected cfg
    = help: the macro `sel_impl` may come from an old version of the `objc` crate, try updating your dependency with `cargo update -p objc`
    = note: see <https://doc.rust-lang.org/nightly/rustc/check-cfg/cargo-specifics.html> for more information about checking conditional configuration
    = note: this warning originates in the macro `sel_impl` which comes from the expansion of the macro `msg_send` (in Nightly builds, run with -Z macro-backtrace for more info)

warning: unexpected `cfg` condition value: `cargo-clippy`
   --> src/commands/native_terminal.rs:651:21
    |
651 |         let _: () = msg_send![host_view, addSubview: scroll_view];
    |                     ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
    |
    = note: no expected values for `feature`
    = note: using a cfg inside a macro will use the cfgs from the destination crate and not the ones from the defining crate
    = help: try referring to `sel_impl` crate for guidance on how handle this unexpected cfg
    = help: the macro `sel_impl` may come from an old version of the `objc` crate, try updating your dependency with `cargo update -p objc`
    = note: see <https://doc.rust-lang.org/nightly/rustc/check-cfg/cargo-specifics.html> for more information about checking conditional configuration
    = note: this warning originates in the macro `sel_impl` which comes from the expansion of the macro `msg_send` (in Nightly builds, run with -Z macro-backtrace for more info)

warning: unexpected `cfg` condition value: `cargo-clippy`
   --> src/commands/native_terminal.rs:652:21
    |
652 |         let _: () = msg_send![ns_view, addSubview: host_view];
    |                     ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
    |
    = note: no expected values for `feature`
    = note: using a cfg inside a macro will use the cfgs from the destination crate and not the ones from the defining crate
    = help: try referring to `sel_impl` crate for guidance on how handle this unexpected cfg
    = help: the macro `sel_impl` may come from an old version of the `objc` crate, try updating your dependency with `cargo update -p objc`
    = note: see <https://doc.rust-lang.org/nightly/rustc/check-cfg/cargo-specifics.html> for more information about checking conditional configuration
    = note: this warning originates in the macro `sel_impl` which comes from the expansion of the macro `msg_send` (in Nightly builds, run with -Z macro-backtrace for more info)

warning: unexpected `cfg` condition value: `cargo-clippy`
   --> src/commands/native_terminal.rs:654:26
    |
654 |         let window: id = msg_send![ns_view, window];
    |                          ^^^^^^^^^^^^^^^^^^^^^^^^^^
    |
    = note: no expected values for `feature`
    = note: using a cfg inside a macro will use the cfgs from the destination crate and not the ones from the defining crate
    = help: try referring to `sel_impl` crate for guidance on how handle this unexpected cfg
    = help: the macro `sel_impl` may come from an old version of the `objc` crate, try updating your dependency with `cargo update -p objc`
    = note: see <https://doc.rust-lang.org/nightly/rustc/check-cfg/cargo-specifics.html> for more information about checking conditional configuration
    = note: this warning originates in the macro `sel_impl` which comes from the expansion of the macro `msg_send` (in Nightly builds, run with -Z macro-backtrace for more info)

warning: unexpected `cfg` condition value: `cargo-clippy`
   --> src/commands/native_terminal.rs:655:21
    |
655 |         let _: () = msg_send![window, makeFirstResponder: host_view];
    |                     ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
    |
    = note: no expected values for `feature`
    = note: using a cfg inside a macro will use the cfgs from the destination crate and not the ones from the defining crate
    = help: try referring to `sel_impl` crate for guidance on how handle this unexpected cfg
    = help: the macro `sel_impl` may come from an old version of the `objc` crate, try updating your dependency with `cargo update -p objc`
    = note: see <https://doc.rust-lang.org/nightly/rustc/check-cfg/cargo-specifics.html> for more information about checking conditional configuration
    = note: this warning originates in the macro `sel_impl` which comes from the expansion of the macro `msg_send` (in Nightly builds, run with -Z macro-backtrace for more info)

warning: unexpected `cfg` condition value: `cargo-clippy`
   --> src/commands/native_terminal.rs:753:21
    |
753 |         let _: () = msg_send![host_view, removeFromSuperview];
    |                     ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
    |
    = note: no expected values for `feature`
    = note: using a cfg inside a macro will use the cfgs from the destination crate and not the ones from the defining crate
    = help: try referring to `sel_impl` crate for guidance on how handle this unexpected cfg
    = help: the macro `sel_impl` may come from an old version of the `objc` crate, try updating your dependency with `cargo update -p objc`
    = note: see <https://doc.rust-lang.org/nightly/rustc/check-cfg/cargo-specifics.html> for more information about checking conditional configuration
    = note: this warning originates in the macro `sel_impl` which comes from the expansion of the macro `msg_send` (in Nightly builds, run with -Z macro-backtrace for more info)

warning: use of deprecated trait `cocoa::appkit::NSColor`: use the objc2-app-kit crate instead
 --> src/commands/native_terminal.rs:7:24
  |
7 |     use cocoa::appkit::NSColor;
  |                        ^^^^^^^
  |
  = note: `#[warn(deprecated)]` on by default

warning: use of deprecated type alias `cocoa::base::id`: use the objc2 crate instead
 --> src/commands/native_terminal.rs:8:23
  |
8 |     use cocoa::base::{id, nil, NO, YES};
  |                       ^^

warning: use of deprecated constant `cocoa::base::nil`: use the objc2 crate instead
 --> src/commands/native_terminal.rs:8:27
  |
8 |     use cocoa::base::{id, nil, NO, YES};
  |                           ^^^

warning: use of deprecated struct `cocoa::foundation::NSPoint`: use the objc2-foundation crate instead
 --> src/commands/native_terminal.rs:9:29
  |
9 |     use cocoa::foundation::{NSPoint, NSRange, NSRect, NSSize, NSString};
  |                             ^^^^^^^

warning: use of deprecated struct `cocoa::foundation::NSRange`: use the objc2-foundation crate instead
 --> src/commands/native_terminal.rs:9:38
  |
9 |     use cocoa::foundation::{NSPoint, NSRange, NSRect, NSSize, NSString};
  |                                      ^^^^^^^

warning: use of deprecated struct `cocoa::foundation::NSRect`: use the objc2-foundation crate instead
 --> src/commands/native_terminal.rs:9:47
  |
9 |     use cocoa::foundation::{NSPoint, NSRange, NSRect, NSSize, NSString};
  |                                               ^^^^^^

warning: use of deprecated struct `cocoa::foundation::NSSize`: use the objc2-foundation crate instead
 --> src/commands/native_terminal.rs:9:55
  |
9 |     use cocoa::foundation::{NSPoint, NSRange, NSRect, NSSize, NSString};
  |                                                       ^^^^^^

warning: use of deprecated trait `cocoa::foundation::NSString`: use the objc2-foundation crate instead
 --> src/commands/native_terminal.rs:9:63
  |
9 |     use cocoa::foundation::{NSPoint, NSRange, NSRect, NSSize, NSString};
  |                                                               ^^^^^^^^

warning: use of deprecated type alias `cocoa::base::id`: use the objc2 crate instead
  --> src/commands/native_terminal.rs:67:71
   |
67 |                     text_view_key_down as extern "C" fn(&Object, Sel, id),
   |                                                                       ^^

warning: use of deprecated type alias `cocoa::base::id`: use the objc2 crate instead
  --> src/commands/native_terminal.rs:71:68
   |
71 |                     text_view_paste as extern "C" fn(&Object, Sel, id),
   |                                                                    ^^

warning: use of deprecated type alias `cocoa::base::id`: use the objc2 crate instead
  --> src/commands/native_terminal.rs:75:75
   |
75 |                     text_view_scroll_wheel as extern "C" fn(&Object, Sel, id),
   |                                                                           ^^

warning: use of deprecated type alias `cocoa::base::id`: use the objc2 crate instead
  --> src/commands/native_terminal.rs:84:72
   |
84 |     extern "C" fn text_view_scroll_wheel(this: &Object, _: Sel, event: id) {
   |                                                                        ^^

warning: use of deprecated type alias `cocoa::base::id`: use the objc2 crate instead
  --> src/commands/native_terminal.rs:88:30
   |
88 |             let scroll_view: id = msg_send![this, superview];
   |                              ^^

warning: use of deprecated constant `cocoa::base::nil`: use the objc2 crate instead
  --> src/commands/native_terminal.rs:89:31
   |
89 |             if scroll_view != nil {
   |                               ^^^

warning: use of deprecated type alias `cocoa::base::id`: use the objc2 crate instead
  --> src/commands/native_terminal.rs:90:32
   |
90 |                 let host_view: id = msg_send![scroll_view, superview];
   |                                ^^

warning: use of deprecated constant `cocoa::base::nil`: use the objc2 crate instead
  --> src/commands/native_terminal.rs:91:33
   |
91 |                 if host_view != nil {
   |                                 ^^^

warning: use of deprecated type alias `cocoa::base::id`: use the objc2 crate instead
   --> src/commands/native_terminal.rs:114:68
    |
114 |     extern "C" fn text_view_key_down(this: &Object, _: Sel, event: id) {
    |                                                                    ^^

warning: use of deprecated type alias `cocoa::base::id`: use the objc2 crate instead
   --> src/commands/native_terminal.rs:116:30
    |
116 |             let scroll_view: id = msg_send![this, superview];
    |                              ^^

warning: use of deprecated constant `cocoa::base::nil`: use the objc2 crate instead
   --> src/commands/native_terminal.rs:117:31
    |
117 |             if scroll_view != nil {
    |                               ^^^

warning: use of deprecated type alias `cocoa::base::id`: use the objc2 crate instead
   --> src/commands/native_terminal.rs:118:32
    |
118 |                 let host_view: id = msg_send![scroll_view, superview];
    |                                ^^

warning: use of deprecated constant `cocoa::base::nil`: use the objc2 crate instead
   --> src/commands/native_terminal.rs:119:33
    |
119 |                 if host_view != nil {
    |                                 ^^^

warning: use of deprecated type alias `cocoa::base::id`: use the objc2 crate instead
   --> src/commands/native_terminal.rs:128:66
    |
128 |     extern "C" fn text_view_paste(this: &Object, _: Sel, sender: id) {
    |                                                                  ^^

warning: use of deprecated type alias `cocoa::base::id`: use the objc2 crate instead
   --> src/commands/native_terminal.rs:130:30
    |
130 |             let scroll_view: id = msg_send![this, superview];
    |                              ^^

warning: use of deprecated constant `cocoa::base::nil`: use the objc2 crate instead
   --> src/commands/native_terminal.rs:131:31
    |
131 |             if scroll_view != nil {
    |                               ^^^

warning: use of deprecated type alias `cocoa::base::id`: use the objc2 crate instead
   --> src/commands/native_terminal.rs:132:32
    |
132 |                 let host_view: id = msg_send![scroll_view, superview];
    |                                ^^

warning: use of deprecated constant `cocoa::base::nil`: use the objc2 crate instead
   --> src/commands/native_terminal.rs:133:33
    |
133 |                 if host_view != nil {
    |                                 ^^^

warning: use of deprecated type alias `cocoa::base::id`: use the objc2 crate instead
   --> src/commands/native_terminal.rs:154:63
    |
154 |                     mouse_down as extern "C" fn(&Object, Sel, id),
    |                                                               ^^

warning: use of deprecated type alias `cocoa::base::id`: use the objc2 crate instead
   --> src/commands/native_terminal.rs:156:89
    |
156 |                 decl.add_method(sel!(keyDown:), key_down as extern "C" fn(&Object, Sel, id));
    |                                                                                         ^^

warning: use of deprecated type alias `cocoa::base::id`: use the objc2 crate instead
   --> src/commands/native_terminal.rs:157:84
    |
157 |                 decl.add_method(sel!(paste:), paste as extern "C" fn(&Object, Sel, id));
    |                                                                                    ^^

warning: use of deprecated type alias `cocoa::base::id`: use the objc2 crate instead
   --> src/commands/native_terminal.rs:160:65
    |
160 |                     scroll_wheel as extern "C" fn(&Object, Sel, id),
    |                                                                 ^^

warning: use of deprecated type alias `cocoa::base::id`: use the objc2 crate instead
   --> src/commands/native_terminal.rs:175:56
    |
175 |     extern "C" fn mouse_down(this: &Object, _: Sel, _: id) {
    |                                                        ^^

warning: use of deprecated type alias `cocoa::base::id`: use the objc2 crate instead
   --> src/commands/native_terminal.rs:177:25
    |
177 |             let window: id = msg_send![this, window];
    |                         ^^

warning: use of deprecated type alias `cocoa::base::id`: use the objc2 crate instead
   --> src/commands/native_terminal.rs:182:58
    |
182 |     extern "C" fn key_down(this: &Object, _: Sel, event: id) {
    |                                                          ^^

warning: use of deprecated type alias `cocoa::base::id`: use the objc2 crate instead
   --> src/commands/native_terminal.rs:188:51
    |
188 |     extern "C" fn paste(this: &Object, _: Sel, _: id) {
    |                                                   ^^

warning: use of deprecated type alias `cocoa::base::id`: use the objc2 crate instead
   --> src/commands/native_terminal.rs:194:62
    |
194 |     extern "C" fn scroll_wheel(this: &Object, _: Sel, event: id) {
    |                                                              ^^

warning: use of deprecated type alias `cocoa::base::id`: use the objc2 crate instead
   --> src/commands/native_terminal.rs:221:31
    |
221 |                 let subviews: id = msg_send![this, subviews];
    |                               ^^

warning: use of deprecated type alias `cocoa::base::id`: use the objc2 crate instead
   --> src/commands/native_terminal.rs:224:38
    |
224 |                     let scroll_view: id = msg_send![subviews, objectAtIndex: 0u64];
    |                                      ^^

warning: use of deprecated type alias `cocoa::base::id`: use the objc2 crate instead
   --> src/commands/native_terminal.rs:271:34
    |
271 |     fn event_to_pty_input(event: id) -> Option<String> {
    |                                  ^^

warning: use of deprecated type alias `cocoa::base::id`: use the objc2 crate instead
   --> src/commands/native_terminal.rs:277:28
    |
277 |                 let value: id = msg_send![event, charactersIgnoringModifiers];
    |                            ^^

warning: use of deprecated type alias `cocoa::base::id`: use the objc2 crate instead
   --> src/commands/native_terminal.rs:307:24
    |
307 |             let value: id = msg_send![event, charactersIgnoringModifiers];
    |                        ^^

warning: use of deprecated type alias `cocoa::base::id`: use the objc2 crate instead
   --> src/commands/native_terminal.rs:336:29
    |
336 |             let pasteboard: id = msg_send![class!(NSPasteboard), generalPasteboard];
    |                             ^^

warning: use of deprecated associated function `cocoa::foundation::NSString::alloc`: use the objc2-foundation crate instead
   --> src/commands/native_terminal.rs:337:41
    |
337 |             let string_type = NSString::alloc(nil).init_str("public.utf8-plain-text");
    |                                         ^^^^^

warning: use of deprecated constant `cocoa::base::nil`: use the objc2 crate instead
   --> src/commands/native_terminal.rs:337:47
    |
337 |             let string_type = NSString::alloc(nil).init_str("public.utf8-plain-text");
    |                                               ^^^

warning: use of deprecated type alias `cocoa::base::id`: use the objc2 crate instead
   --> src/commands/native_terminal.rs:338:24
    |
338 |             let value: id = msg_send![pasteboard, stringForType: string_type];
    |                        ^^

warning: use of deprecated constant `cocoa::base::nil`: use the objc2 crate instead
   --> src/commands/native_terminal.rs:339:25
    |
339 |             if value == nil {
    |                         ^^^

warning: use of deprecated type alias `cocoa::base::id`: use the objc2 crate instead
   --> src/commands/native_terminal.rs:347:41
    |
347 |     unsafe fn nsstring_to_string(value: id) -> String {
    |                                         ^^

warning: use of deprecated constant `cocoa::base::nil`: use the objc2 crate instead
   --> src/commands/native_terminal.rs:348:21
    |
348 |         if value == nil {
    |                     ^^^

warning: use of deprecated type alias `cocoa::base::id`: use the objc2 crate instead
   --> src/commands/native_terminal.rs:359:70
    |
359 |     unsafe fn ns_color_from_rgb(rgb: (f64, f64, f64), alpha: f64) -> id {
    |                                                                      ^^

warning: use of deprecated associated function `cocoa::appkit::NSColor::colorWithCalibratedRed_green_blue_alpha_`: use the objc2-app-kit crate instead
   --> src/commands/native_terminal.rs:360:18
    |
360 |         NSColor::colorWithCalibratedRed_green_blue_alpha_(nil, rgb.0, rgb.1, rgb.2, alpha)
    |                  ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^

warning: use of deprecated constant `cocoa::base::nil`: use the objc2 crate instead
   --> src/commands/native_terminal.rs:360:59
    |
360 |         NSColor::colorWithCalibratedRed_green_blue_alpha_(nil, rgb.0, rgb.1, rgb.2, alpha)
    |                                                           ^^^

warning: use of deprecated type alias `cocoa::base::id`: use the objc2 crate instead
   --> src/commands/native_terminal.rs:428:40
    |
428 |     unsafe fn render_parser(text_view: id, parser: &vt100::Parser) {
    |                                        ^^

warning: use of deprecated type alias `cocoa::base::id`: use the objc2 crate instead
   --> src/commands/native_terminal.rs:430:27
    |
430 |         let text_storage: id = msg_send![text_view, textStorage];
    |                           ^^

warning: use of deprecated type alias `cocoa::base::id`: use the objc2 crate instead
   --> src/commands/native_terminal.rs:433:27
    |
433 |         let enclosing_sv: id = msg_send![text_view, enclosingScrollView];
    |                           ^^

warning: use of deprecated constant `cocoa::base::nil`: use the objc2 crate instead
   --> src/commands/native_terminal.rs:434:48
    |
434 |         let was_at_bottom = if enclosing_sv != nil {
    |                                                ^^^

warning: use of deprecated type alias `cocoa::base::id`: use the objc2 crate instead
   --> src/commands/native_terminal.rs:435:28
    |
435 |             let clip_view: id = msg_send![enclosing_sv, contentView];
    |                            ^^

warning: use of deprecated struct `cocoa::foundation::NSRect`: use the objc2-foundation crate instead
   --> src/commands/native_terminal.rs:436:30
    |
436 |             let clip_bounds: NSRect = msg_send![clip_view, bounds];
    |                              ^^^^^^

warning: use of deprecated struct `cocoa::foundation::NSRect`: use the objc2-foundation crate instead
   --> src/commands/native_terminal.rs:437:28
    |
437 |             let doc_frame: NSRect = msg_send![text_view, frame];
    |                            ^^^^^^

warning: use of deprecated struct `cocoa::foundation::NSRect`: use the objc2-foundation crate instead
   --> src/commands/native_terminal.rs:438:27
    |
438 |             let sv_frame: NSRect = msg_send![enclosing_sv, frame];
    |                           ^^^^^^

warning: use of deprecated type alias `cocoa::base::id`: use the objc2 crate instead
   --> src/commands/native_terminal.rs:449:30
    |
449 |             let full_string: id = msg_send![attributed, string];
    |                              ^^

warning: use of deprecated struct `cocoa::foundation::NSRange`: use the objc2-foundation crate instead
   --> src/commands/native_terminal.rs:451:25
    |
451 |             let range = NSRange::new(length.saturating_sub(1), 1);
    |                         ^^^^^^^

warning: use of deprecated type alias `cocoa::base::id`: use the objc2 crate instead
   --> src/commands/native_terminal.rs:457:18
    |
457 |         mutable: id,
    |                  ^^

warning: use of deprecated type alias `cocoa::base::id`: use the objc2 crate instead
   --> src/commands/native_terminal.rs:467:20
    |
467 |         let attrs: id = msg_send![class!(NSMutableDictionary), alloc];
    |                    ^^

warning: use of deprecated type alias `cocoa::base::id`: use the objc2 crate instead
   --> src/commands/native_terminal.rs:468:20
    |
468 |         let attrs: id = msg_send![attrs, init];
    |                    ^^

warning: use of deprecated associated function `cocoa::foundation::NSString::alloc`: use the objc2-foundation crate instead
   --> src/commands/native_terminal.rs:470:38
    |
470 |         let font_name_ns = NSString::alloc(nil).init_str(font_name);
    |                                      ^^^^^

warning: use of deprecated constant `cocoa::base::nil`: use the objc2 crate instead
   --> src/commands/native_terminal.rs:470:44
    |
470 |         let font_name_ns = NSString::alloc(nil).init_str(font_name);
    |                                            ^^^

warning: use of deprecated type alias `cocoa::base::id`: use the objc2 crate instead
   --> src/commands/native_terminal.rs:471:19
    |
471 |         let font: id = msg_send![class!(NSFont), fontWithName: font_name_ns size: 13.0];
    |                   ^^

warning: use of deprecated type alias `cocoa::base::id`: use the objc2 crate instead
   --> src/commands/native_terminal.rs:472:28
    |
472 |         let fallback_font: id = msg_send![class!(NSFont), userFixedPitchFontOfSize: 13.0];
    |                            ^^

warning: use of deprecated constant `cocoa::base::nil`: use the objc2 crate instead
   --> src/commands/native_terminal.rs:473:38
    |
473 |         let font_to_use = if font == nil { fallback_font } else { font };
    |                                      ^^^

warning: use of deprecated associated function `cocoa::foundation::NSString::alloc`: use the objc2-foundation crate instead
   --> src/commands/native_terminal.rs:478:31
    |
478 |             forKey: NSString::alloc(nil).init_str("NSFont")
    |                               ^^^^^

warning: use of deprecated constant `cocoa::base::nil`: use the objc2 crate instead
   --> src/commands/native_terminal.rs:478:37
    |
478 |             forKey: NSString::alloc(nil).init_str("NSFont")
    |                                     ^^^

warning: use of deprecated associated function `cocoa::foundation::NSString::alloc`: use the objc2-foundation crate instead
   --> src/commands/native_terminal.rs:483:31
    |
483 |             forKey: NSString::alloc(nil).init_str("NSColor")
    |                               ^^^^^

warning: use of deprecated constant `cocoa::base::nil`: use the objc2 crate instead
   --> src/commands/native_terminal.rs:483:37
    |
483 |             forKey: NSString::alloc(nil).init_str("NSColor")
    |                                     ^^^

warning: use of deprecated associated function `cocoa::foundation::NSString::alloc`: use the objc2-foundation crate instead
   --> src/commands/native_terminal.rs:490:35
    |
490 |                 forKey: NSString::alloc(nil).init_str("NSBackgroundColor")
    |                                   ^^^^^

warning: use of deprecated constant `cocoa::base::nil`: use the objc2 crate instead
   --> src/commands/native_terminal.rs:490:41
    |
490 |                 forKey: NSString::alloc(nil).init_str("NSBackgroundColor")
    |                                         ^^^

warning: use of deprecated type alias `cocoa::base::id`: use the objc2 crate instead
   --> src/commands/native_terminal.rs:494:34
    |
494 |             let underline_style: id = msg_send![class!(NSNumber), numberWithInt: 1i32];
    |                                  ^^

warning: use of deprecated associated function `cocoa::foundation::NSString::alloc`: use the objc2-foundation crate instead
   --> src/commands/native_terminal.rs:498:35
    |
498 |                 forKey: NSString::alloc(nil).init_str("NSUnderline")
    |                                   ^^^^^

warning: use of deprecated constant `cocoa::base::nil`: use the objc2 crate instead
   --> src/commands/native_terminal.rs:498:41
    |
498 |                 forKey: NSString::alloc(nil).init_str("NSUnderline")
    |                                         ^^^

warning: use of deprecated associated function `cocoa::foundation::NSString::alloc`: use the objc2-foundation crate instead
   --> src/commands/native_terminal.rs:502:33
    |
502 |         let ns_text = NSString::alloc(nil).init_str(text);
    |                                 ^^^^^

warning: use of deprecated constant `cocoa::base::nil`: use the objc2 crate instead
   --> src/commands/native_terminal.rs:502:39
    |
502 |         let ns_text = NSString::alloc(nil).init_str(text);
    |                                       ^^^

warning: use of deprecated type alias `cocoa::base::id`: use the objc2 crate instead
   --> src/commands/native_terminal.rs:503:23
    |
503 |         let fragment: id = msg_send![class!(NSAttributedString), alloc];
    |                       ^^

warning: use of deprecated type alias `cocoa::base::id`: use the objc2 crate instead
   --> src/commands/native_terminal.rs:504:23
    |
504 |         let fragment: id = msg_send![fragment, initWithString: ns_text attributes: attrs];
    |                       ^^

warning: use of deprecated type alias `cocoa::base::id`: use the objc2 crate instead
   --> src/commands/native_terminal.rs:508:69
    |
508 |     unsafe fn attributed_terminal_screen(parser: &vt100::Parser) -> id {
    |                                                                     ^^

warning: use of deprecated type alias `cocoa::base::id`: use the objc2 crate instead
   --> src/commands/native_terminal.rs:511:22
    |
511 |         let mutable: id = msg_send![class!(NSMutableAttributedString), alloc];
    |                      ^^

warning: use of deprecated type alias `cocoa::base::id`: use the objc2 crate instead
   --> src/commands/native_terminal.rs:512:22
    |
512 |         let mutable: id = msg_send![mutable, init];
    |                      ^^

warning: use of deprecated type alias `cocoa::base::id`: use the objc2 crate instead
   --> src/commands/native_terminal.rs:567:48
    |
567 |     unsafe fn resize_text_container(text_view: id, width: f64) {
    |                                                ^^

warning: use of deprecated type alias `cocoa::base::id`: use the objc2 crate instead
   --> src/commands/native_terminal.rs:568:29
    |
568 |         let text_container: id = msg_send![text_view, textContainer];
    |                             ^^

warning: use of deprecated struct `cocoa::foundation::NSSize`: use the objc2-foundation crate instead
   --> src/commands/native_terminal.rs:569:65
    |
569 |         let _: () = msg_send![text_container, setContainerSize: NSSize::new(width.max(1.0), f64::MAX)];
    |                                                                 ^^^^^^

warning: use of deprecated type alias `cocoa::base::id`: use the objc2 crate instead
   --> src/commands/native_terminal.rs:586:38
    |
586 |         let ns_view = ns_view_ptr as id;
    |                                      ^^

warning: use of deprecated constant `cocoa::base::nil`: use the objc2 crate instead
   --> src/commands/native_terminal.rs:587:23
    |
587 |         if ns_view == nil {
    |                       ^^^

warning: use of deprecated struct `cocoa::foundation::NSRect`: use the objc2-foundation crate instead
   --> src/commands/native_terminal.rs:591:26
    |
591 |         let root_bounds: NSRect = msg_send![ns_view, bounds];
    |                          ^^^^^^

warning: use of deprecated struct `cocoa::foundation::NSRect`: use the objc2-foundation crate instead
   --> src/commands/native_terminal.rs:592:21
    |
592 |         let frame = NSRect::new(
    |                     ^^^^^^

warning: use of deprecated struct `cocoa::foundation::NSPoint`: use the objc2-foundation crate instead
   --> src/commands/native_terminal.rs:593:13
    |
593 |             NSPoint::new(x.max(0.0), (root_bounds.size.height - y - height).max(0.0)),
    |             ^^^^^^^

warning: use of deprecated struct `cocoa::foundation::NSSize`: use the objc2-foundation crate instead
   --> src/commands/native_terminal.rs:594:13
    |
594 |             NSSize::new(width.max(0.0), height.max(0.0)),
    |             ^^^^^^

warning: use of deprecated struct `cocoa::foundation::NSRect`: use the objc2-foundation crate instead
   --> src/commands/native_terminal.rs:596:27
    |
596 |         let inner_frame = NSRect::new(NSPoint::new(0.0, 0.0), frame.size);
    |                           ^^^^^^

warning: use of deprecated struct `cocoa::foundation::NSPoint`: use the objc2-foundation crate instead
   --> src/commands/native_terminal.rs:596:39
    |
596 |         let inner_frame = NSRect::new(NSPoint::new(0.0, 0.0), frame.size);
    |                                       ^^^^^^^

warning: use of deprecated type alias `cocoa::base::id`: use the objc2 crate instead
   --> src/commands/native_terminal.rs:600:49
    |
600 |             let host_view = handle.host_view as id;
    |                                                 ^^

warning: use of deprecated type alias `cocoa::base::id`: use the objc2 crate instead
   --> src/commands/native_terminal.rs:601:53
    |
601 |             let scroll_view = handle.scroll_view as id;
    |                                                     ^^

warning: use of deprecated type alias `cocoa::base::id`: use the objc2 crate instead
   --> src/commands/native_terminal.rs:602:49
    |
602 |             let text_view = handle.text_view as id;
    |                                                 ^^

warning: use of deprecated type alias `cocoa::base::id`: use the objc2 crate instead
   --> src/commands/native_terminal.rs:614:24
    |
614 |         let host_view: id = msg_send![host_class, alloc];
    |                        ^^

warning: use of deprecated type alias `cocoa::base::id`: use the objc2 crate instead
   --> src/commands/native_terminal.rs:615:24
    |
615 |         let host_view: id = msg_send![host_view, initWithFrame: frame];
    |                        ^^

warning: use of deprecated type alias `cocoa::base::id`: use the objc2 crate instead
   --> src/commands/native_terminal.rs:619:26
    |
619 |         let scroll_view: id = msg_send![class!(NSScrollView), alloc];
    |                          ^^

warning: use of deprecated type alias `cocoa::base::id`: use the objc2 crate instead
   --> src/commands/native_terminal.rs:620:26
    |
620 |         let scroll_view: id = msg_send![scroll_view, initWithFrame: inner_frame];
    |                          ^^

warning: use of deprecated type alias `cocoa::base::id`: use the objc2 crate instead
   --> src/commands/native_terminal.rs:628:24
    |
628 |         let text_view: id = msg_send![text_view_class, alloc];
    |                        ^^

warning: use of deprecated type alias `cocoa::base::id`: use the objc2 crate instead
   --> src/commands/native_terminal.rs:629:24
    |
629 |         let text_view: id = msg_send![text_view, initWithFrame: inner_frame];
    |                        ^^

warning: use of deprecated type alias `cocoa::base::id`: use the objc2 crate instead
   --> src/commands/native_terminal.rs:640:19
    |
640 |         let font: id = msg_send![class!(NSFont), userFixedPitchFontOfSize: 13.0];
    |                   ^^

warning: use of deprecated associated function `cocoa::appkit::NSColor::colorWithCalibratedRed_green_blue_alpha_`: use the objc2-app-kit crate instead
   --> src/commands/native_terminal.rs:642:35
    |
642 |         let background = NSColor::colorWithCalibratedRed_green_blue_alpha_(nil, 0.039, 0.039, 0.047, 1.0);
    |                                   ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^

warning: use of deprecated constant `cocoa::base::nil`: use the objc2 crate instead
   --> src/commands/native_terminal.rs:642:76
    |
642 |         let background = NSColor::colorWithCalibratedRed_green_blue_alpha_(nil, 0.039, 0.039, 0.047, 1.0);
    |                                                                            ^^^

warning: use of deprecated associated function `cocoa::appkit::NSColor::colorWithCalibratedRed_green_blue_alpha_`: use the objc2-app-kit crate instead
   --> src/commands/native_terminal.rs:643:35
    |
643 |         let foreground = NSColor::colorWithCalibratedRed_green_blue_alpha_(nil, 0.89, 0.89, 0.91, 1.0);
    |                                   ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^

warning: use of deprecated constant `cocoa::base::nil`: use the objc2 crate instead
   --> src/commands/native_terminal.rs:643:76
    |
643 |         let foreground = NSColor::colorWithCalibratedRed_green_blue_alpha_(nil, 0.89, 0.89, 0.91, 1.0);
    |                                                                            ^^^

warning: use of deprecated associated function `cocoa::foundation::NSString::alloc`: use the objc2-foundation crate instead
   --> src/commands/native_terminal.rs:647:63
    |
647 |         let _: () = msg_send![text_view, setString: NSString::alloc(nil).init_str("")];
    |                                                               ^^^^^

warning: use of deprecated constant `cocoa::base::nil`: use the objc2 crate instead
   --> src/commands/native_terminal.rs:647:69
    |
647 |         let _: () = msg_send![text_view, setString: NSString::alloc(nil).init_str("")];
    |                                                                     ^^^

warning: use of deprecated type alias `cocoa::base::id`: use the objc2 crate instead
   --> src/commands/native_terminal.rs:654:21
    |
654 |         let window: id = msg_send![ns_view, window];
    |                     ^^

warning: use of deprecated type alias `cocoa::base::id`: use the objc2 crate instead
   --> src/commands/native_terminal.rs:685:43
    |
685 |         render_parser(handle.text_view as id, &handle.parser);
    |                                           ^^

warning: use of deprecated type alias `cocoa::base::id`: use the objc2 crate instead
   --> src/commands/native_terminal.rs:715:47
    |
715 |             render_parser(handle.text_view as id, &handle.parser);
    |                                               ^^

warning: use of deprecated type alias `cocoa::base::id`: use the objc2 crate instead
   --> src/commands/native_terminal.rs:739:43
    |
739 |         render_parser(handle.text_view as id, &handle.parser);
    |                                           ^^

warning: use of deprecated type alias `cocoa::base::id`: use the objc2 crate instead
   --> src/commands/native_terminal.rs:752:45
    |
752 |         let host_view = handle.host_view as id;
    |                                             ^^

warning: use of deprecated method `cocoa::foundation::NSString::init_str`: use the objc2-foundation crate instead
   --> src/commands/native_terminal.rs:337:52
    |
337 |             let string_type = NSString::alloc(nil).init_str("public.utf8-plain-text");
    |                                                    ^^^^^^^^

warning: use of deprecated field `cocoa::foundation::NSRect::origin`: use the objc2-foundation crate instead
   --> src/commands/native_terminal.rs:440:14
    |
440 |             (clip_bounds.origin.y + sv_frame.size.height) >= (doc_frame.size.height - 20.0)
    |              ^^^^^^^^^^^^^^^^^^

warning: use of deprecated field `cocoa::foundation::NSPoint::y`: use the objc2-foundation crate instead
   --> src/commands/native_terminal.rs:440:14
    |
440 |             (clip_bounds.origin.y + sv_frame.size.height) >= (doc_frame.size.height - 20.0)
    |              ^^^^^^^^^^^^^^^^^^^^

warning: use of deprecated field `cocoa::foundation::NSRect::size`: use the objc2-foundation crate instead
   --> src/commands/native_terminal.rs:440:37
    |
440 |             (clip_bounds.origin.y + sv_frame.size.height) >= (doc_frame.size.height - 20.0)
    |                                     ^^^^^^^^^^^^^

warning: use of deprecated field `cocoa::foundation::NSSize::height`: use the objc2-foundation crate instead
   --> src/commands/native_terminal.rs:440:37
    |
440 |             (clip_bounds.origin.y + sv_frame.size.height) >= (doc_frame.size.height - 20.0)
    |                                     ^^^^^^^^^^^^^^^^^^^^

warning: use of deprecated field `cocoa::foundation::NSRect::size`: use the objc2-foundation crate instead
   --> src/commands/native_terminal.rs:440:63
    |
440 |             (clip_bounds.origin.y + sv_frame.size.height) >= (doc_frame.size.height - 20.0)
    |                                                               ^^^^^^^^^^^^^^

warning: use of deprecated field `cocoa::foundation::NSSize::height`: use the objc2-foundation crate instead
   --> src/commands/native_terminal.rs:440:63
    |
440 |             (clip_bounds.origin.y + sv_frame.size.height) >= (doc_frame.size.height - 20.0)
    |                                                               ^^^^^^^^^^^^^^^^^^^^^

warning: use of deprecated associated function `cocoa::foundation::NSRange::new`: use the objc2-foundation crate instead
   --> src/commands/native_terminal.rs:451:34
    |
451 |             let range = NSRange::new(length.saturating_sub(1), 1);
    |                                  ^^^

warning: use of deprecated method `cocoa::foundation::NSString::init_str`: use the objc2-foundation crate instead
   --> src/commands/native_terminal.rs:470:49
    |
470 |         let font_name_ns = NSString::alloc(nil).init_str(font_name);
    |                                                 ^^^^^^^^

warning: use of deprecated method `cocoa::foundation::NSString::init_str`: use the objc2-foundation crate instead
   --> src/commands/native_terminal.rs:478:42
    |
478 |             forKey: NSString::alloc(nil).init_str("NSFont")
    |                                          ^^^^^^^^

warning: use of deprecated method `cocoa::foundation::NSString::init_str`: use the objc2-foundation crate instead
   --> src/commands/native_terminal.rs:483:42
    |
483 |             forKey: NSString::alloc(nil).init_str("NSColor")
    |                                          ^^^^^^^^

warning: use of deprecated method `cocoa::foundation::NSString::init_str`: use the objc2-foundation crate instead
   --> src/commands/native_terminal.rs:490:46
    |
490 |                 forKey: NSString::alloc(nil).init_str("NSBackgroundColor")
    |                                              ^^^^^^^^

warning: use of deprecated method `cocoa::foundation::NSString::init_str`: use the objc2-foundation crate instead
   --> src/commands/native_terminal.rs:498:46
    |
498 |                 forKey: NSString::alloc(nil).init_str("NSUnderline")
    |                                              ^^^^^^^^

warning: use of deprecated method `cocoa::foundation::NSString::init_str`: use the objc2-foundation crate instead
   --> src/commands/native_terminal.rs:502:44
    |
502 |         let ns_text = NSString::alloc(nil).init_str(text);
    |                                            ^^^^^^^^

warning: use of deprecated associated function `cocoa::foundation::NSSize::new`: use the objc2-foundation crate instead
   --> src/commands/native_terminal.rs:569:73
    |
569 |         let _: () = msg_send![text_container, setContainerSize: NSSize::new(width.max(1.0), f64::MAX)];
    |                                                                         ^^^

warning: use of deprecated associated function `cocoa::foundation::NSRect::new`: use the objc2-foundation crate instead
   --> src/commands/native_terminal.rs:592:29
    |
592 |         let frame = NSRect::new(
    |                             ^^^

warning: use of deprecated associated function `cocoa::foundation::NSPoint::new`: use the objc2-foundation crate instead
   --> src/commands/native_terminal.rs:593:22
    |
593 |             NSPoint::new(x.max(0.0), (root_bounds.size.height - y - height).max(0.0)),
    |                      ^^^

warning: use of deprecated field `cocoa::foundation::NSRect::size`: use the objc2-foundation crate instead
   --> src/commands/native_terminal.rs:593:39
    |
593 |             NSPoint::new(x.max(0.0), (root_bounds.size.height - y - height).max(0.0)),
    |                                       ^^^^^^^^^^^^^^^^

warning: use of deprecated field `cocoa::foundation::NSSize::height`: use the objc2-foundation crate instead
   --> src/commands/native_terminal.rs:593:39
    |
593 |             NSPoint::new(x.max(0.0), (root_bounds.size.height - y - height).max(0.0)),
    |                                       ^^^^^^^^^^^^^^^^^^^^^^^

warning: use of deprecated associated function `cocoa::foundation::NSSize::new`: use the objc2-foundation crate instead
   --> src/commands/native_terminal.rs:594:21
    |
594 |             NSSize::new(width.max(0.0), height.max(0.0)),
    |                     ^^^

warning: use of deprecated associated function `cocoa::foundation::NSRect::new`: use the objc2-foundation crate instead
   --> src/commands/native_terminal.rs:596:35
    |
596 |         let inner_frame = NSRect::new(NSPoint::new(0.0, 0.0), frame.size);
    |                                   ^^^

warning: use of deprecated associated function `cocoa::foundation::NSPoint::new`: use the objc2-foundation crate instead
   --> src/commands/native_terminal.rs:596:48
    |
596 |         let inner_frame = NSRect::new(NSPoint::new(0.0, 0.0), frame.size);
    |                                                ^^^

warning: use of deprecated field `cocoa::foundation::NSRect::size`: use the objc2-foundation crate instead
   --> src/commands/native_terminal.rs:596:63
    |
596 |         let inner_frame = NSRect::new(NSPoint::new(0.0, 0.0), frame.size);
    |                                                               ^^^^^^^^^^

warning: use of deprecated field `cocoa::foundation::NSRect::size`: use the objc2-foundation crate instead
   --> src/commands/native_terminal.rs:608:46
    |
608 |             resize_text_container(text_view, inner_frame.size.width);
    |                                              ^^^^^^^^^^^^^^^^

warning: use of deprecated field `cocoa::foundation::NSSize::width`: use the objc2-foundation crate instead
   --> src/commands/native_terminal.rs:608:46
    |
608 |             resize_text_container(text_view, inner_frame.size.width);
    |                                              ^^^^^^^^^^^^^^^^^^^^^^

warning: use of deprecated method `cocoa::foundation::NSString::init_str`: use the objc2-foundation crate instead
   --> src/commands/native_terminal.rs:647:74
    |
647 |         let _: () = msg_send![text_view, setString: NSString::alloc(nil).init_str("")];
    |                                                                          ^^^^^^^^

warning: use of deprecated field `cocoa::foundation::NSRect::size`: use the objc2-foundation crate instead
   --> src/commands/native_terminal.rs:648:42
    |
648 |         resize_text_container(text_view, inner_frame.size.width);
    |                                          ^^^^^^^^^^^^^^^^

warning: use of deprecated field `cocoa::foundation::NSSize::width`: use the objc2-foundation crate instead
   --> src/commands/native_terminal.rs:648:42
    |
648 |         resize_text_container(text_view, inner_frame.size.width);
    |                                          ^^^^^^^^^^^^^^^^^^^^^^

warning: `xanom` (lib) generated 254 warnings
Temporary Codex UI edit test line 3.
