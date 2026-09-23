//! Bounded ring buffer for PTY output bytes.
//!
//! Backs the `get_pty_snapshot` command — when a frontend terminal component
//! mounts (or remounts), it pulls the current contents of this buffer to
//! rehydrate xterm.js's parser state instantly, instead of waiting for the
//! PTY to replay history.
//!
//! Capacity is fixed at construction. When pushing would exceed capacity,
//! the oldest bytes are dropped from the front. ANSI sequences may be split
//! at the front of the snapshot, but xterm.js's VT parser discards garbage
//! prefixes until it finds a valid sequence — acceptable for terminal data.

use std::collections::VecDeque;

pub struct RingBuffer {
    buf: VecDeque<u8>,
    capacity: usize,
    /// Cumulative byte offset of the byte that would be written NEXT.
    /// Equivalently: the absolute position right after the most recent byte
    /// in `buf`. The first push starts at offset 0; after pushing N bytes,
    /// `end_offset == N`. This counter never resets and never decreases —
    /// even when bytes are evicted from the front of `buf` due to capacity,
    /// the offset still advances. Backs the snapshot dedup protocol so the
    /// frontend can drop live PTY events that overlap with a snapshot it
    /// just rehydrated from.
    end_offset: u64,
}

impl RingBuffer {
    pub fn new(capacity: usize) -> Self {
        Self {
            buf: VecDeque::with_capacity(capacity),
            capacity,
            end_offset: 0,
        }
    }

    /// Append bytes, dropping the oldest data first if capacity would be exceeded.
    /// Always advances `end_offset` by `data.len()`, regardless of how many
    /// bytes get evicted.
    pub fn push(&mut self, data: &[u8]) {
        self.end_offset = self.end_offset.wrapping_add(data.len() as u64);
        if data.len() >= self.capacity {
            // Single chunk larger than capacity — keep only its tail.
            self.buf.clear();
            let tail_start = data.len() - self.capacity;
            self.buf.extend(&data[tail_start..]);
            return;
        }
        let new_len = self.buf.len() + data.len();
        if new_len > self.capacity {
            let to_drop = new_len - self.capacity;
            self.buf.drain(0..to_drop);
        }
        self.buf.extend(data);
    }

    /// Return a contiguous Vec<u8> copy of the current buffer contents,
    /// along with the absolute end offset (== the offset of the byte that
    /// would be written next). The frontend uses this offset as a watermark
    /// to dedupe overlapping live PTY events after rehydration.
    pub fn snapshot(&self) -> (Vec<u8>, u64) {
        (self.buf.iter().copied().collect(), self.end_offset)
    }

    /// Absolute end offset (== the offset of the byte that would be written
    /// next). Never decreases, even when bytes are evicted from the front.
    /// Only used by tests right now — production callers get this via the
    /// tuple returned from `snapshot()`.
    #[allow(dead_code)]
    pub fn end_offset(&self) -> u64 {
        self.end_offset
    }

    #[allow(dead_code)]
    pub fn len(&self) -> usize {
        self.buf.len()
    }

    #[allow(dead_code)]
    pub fn is_empty(&self) -> bool {
        self.buf.is_empty()
    }

    #[allow(dead_code)]
    pub fn clear(&mut self) {
        self.buf.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_buffer_returns_empty_snapshot() {
        let rb = RingBuffer::new(100);
        assert!(rb.is_empty());
        let (data, end) = rb.snapshot();
        assert_eq!(data, Vec::<u8>::new());
        assert_eq!(end, 0);
    }

    #[test]
    fn push_under_capacity_keeps_all_bytes() {
        let mut rb = RingBuffer::new(100);
        rb.push(b"hello");
        rb.push(b" world");
        assert_eq!(rb.len(), 11);
        let (data, end) = rb.snapshot();
        assert_eq!(data, b"hello world".to_vec());
        assert_eq!(end, 11);
    }

    #[test]
    fn push_over_capacity_drops_oldest() {
        let mut rb = RingBuffer::new(10);
        rb.push(b"0123456789"); // exactly fills, end=10
        rb.push(b"abc"); // forces drop of "012", end=13
        assert_eq!(rb.len(), 10);
        let (data, end) = rb.snapshot();
        assert_eq!(data, b"3456789abc".to_vec());
        assert_eq!(end, 13);
    }

    #[test]
    fn single_chunk_larger_than_capacity_keeps_tail() {
        let mut rb = RingBuffer::new(5);
        rb.push(b"abcdefghij"); // 10 bytes into 5-byte buffer, end=10
        assert_eq!(rb.len(), 5);
        let (data, end) = rb.snapshot();
        assert_eq!(data, b"fghij".to_vec());
        assert_eq!(end, 10);
    }

    #[test]
    fn many_small_pushes_total_under_capacity() {
        let mut rb = RingBuffer::new(1024);
        for i in 0..100u8 {
            rb.push(&[i]);
        }
        assert_eq!(rb.len(), 100);
        let (snap, end) = rb.snapshot();
        assert_eq!(end, 100);
        for (i, b) in snap.iter().enumerate() {
            assert_eq!(*b, i as u8);
        }
    }

    #[test]
    fn end_offset_advances_past_evictions() {
        // The end_offset must reflect the cumulative bytes ever pushed,
        // even when older bytes have been evicted from the buffer.
        let mut rb = RingBuffer::new(4);
        rb.push(b"abcd"); // end=4
        rb.push(b"efgh"); // evicts "abcd", end=8
        rb.push(b"ijkl"); // evicts "efgh", end=12
        assert_eq!(rb.end_offset(), 12);
        let (data, end) = rb.snapshot();
        assert_eq!(data, b"ijkl".to_vec());
        assert_eq!(end, 12);
    }

    #[test]
    fn clear_resets_buffer() {
        let mut rb = RingBuffer::new(10);
        rb.push(b"abc");
        rb.clear();
        assert!(rb.is_empty());
        let (data, end) = rb.snapshot();
        assert_eq!(data, Vec::<u8>::new());
        // end_offset is intentionally NOT reset by clear() — it's a
        // monotonic stream position, not a buffer-fill indicator.
        assert_eq!(end, 3);
    }
}
