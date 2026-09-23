Run a Qodo self-review on the current repository's uncommitted changes.

## Steps

1. Run `qodo self-review --model gpt-5.4` to open the Qodo web interface for reviewing git changes.
2. Wait for the user to share the results or findings from Qodo.
3. For each issue Qodo identifies, present the recommended fix as a code snippet.
4. Ask: **"Would you like me to apply these fixes? (all / pick specific numbers / no)"**
5. Do NOT make any changes until the user explicitly approves.
