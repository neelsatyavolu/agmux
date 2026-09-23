# Image Upload for Codex & Claude Chat

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable image attachments in both Codex and Claude chat inputs via drag-and-drop, paste, and file picker.

**Architecture:** Codex uses its JSON-RPC `input` array which already supports `image` type objects — we extend the Rust command and app_server to pass base64-encoded images alongside text. Claude uses PTY stdin — we save images to temp files and send the file path as text input.

**Tech Stack:** React, TypeScript, Tauri v2 (Rust), base64 encoding, Tauri dialog plugin

---

## Chunk 1: Backend — Rust Changes

### Task 1: Add image support to Codex app_server.rs

**Files:**
- Modify: `src-tauri/src/codex/app_server.rs` (send_message function)

- [ ] **Step 1: Update `send_message` signature** to accept `images: &[ImageAttachment]`
- [ ] **Step 2: Build input array** with both text and image objects
- [ ] **Step 3: Define `ImageAttachment` struct** with `data` (base64) and `media_type` fields

### Task 2: Add image support to codex command

**Files:**
- Modify: `src-tauri/src/commands/codex.rs` (codex_send_message)

- [ ] **Step 1: Add `images` parameter** to `codex_send_message` as `Option<Vec<ImageAttachment>>`
- [ ] **Step 2: Pass images through** to `server.send_message()`
- [ ] **Step 3: Add image validation** (max size, allowed media types)

### Task 3: Add save_temp_image command for Claude

**Files:**
- Modify: `src-tauri/src/commands/files.rs`

- [ ] **Step 1: Add `save_temp_image` command** that accepts base64 data and saves to `~/.xanom/tmp/`
- [ ] **Step 2: Return the saved file path** so frontend can send it to PTY
- [ ] **Step 3: Register command** in `lib.rs`

## Chunk 2: Frontend — Shared Component + Integration

### Task 4: Create ImageAttachmentBar component

**Files:**
- Create: `src/components/thread/ImageAttachmentBar.tsx`

- [ ] **Step 1: Build component** with drag-and-drop zone, paste handler, and file picker button
- [ ] **Step 2: Show image thumbnails** with remove button
- [ ] **Step 3: Export `useImageAttachments` hook** for state management (attachedImages, addImage, removeImage, clearImages)

### Task 5: Integrate into CodexSessionView

**Files:**
- Modify: `src/components/thread/CodexSessionView.tsx`
- Modify: `src/lib/commands.ts`

- [ ] **Step 1: Update `codexSendMessage` in commands.ts** to accept optional images array
- [ ] **Step 2: Add ImageAttachmentBar** to the input area
- [ ] **Step 3: Pass images** to codexSendMessage on send, clear after send

### Task 6: Integrate into ClaudeInputBar

**Files:**
- Modify: `src/components/thread/ClaudeInputBar.tsx`
- Modify: `src/lib/commands.ts`

- [ ] **Step 1: Add `saveTempImage` command wrapper** in commands.ts
- [ ] **Step 2: Add ImageAttachmentBar** to the input area
- [ ] **Step 3: On send, save pasted images to temp files**, prepend paths to message text, send via PTY
