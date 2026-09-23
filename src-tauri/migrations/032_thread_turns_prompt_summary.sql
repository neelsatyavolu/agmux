-- Short LLM/extractive title for the user prompt (display); keep prompt_text for rebind.
ALTER TABLE thread_turns ADD COLUMN prompt_summary TEXT;
