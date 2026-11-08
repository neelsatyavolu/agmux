//! Newline-delimited reads with a per-line byte cap for local sockets.
//!
//! `AsyncBufReadExt::lines` buffers until it sees `\n`, so a client that never
//! sends one grows memory without bound. These readers stop at `max` bytes.

use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncReadExt};

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum BoundedLine {
    Line(String),
    /// The line exceeded the cap; the connection should be dropped.
    TooLong,
    Eof,
}

/// Read one line (without the trailing `\n`/`\r\n`), at most `max` bytes.
/// Invalid UTF-8 is replaced rather than failing the connection.
pub(crate) async fn read_bounded_line<R: AsyncBufRead + Unpin>(
    reader: &mut R,
    max: usize,
) -> std::io::Result<BoundedLine> {
    let mut buf = Vec::new();
    let read = (&mut *reader).take(max as u64 + 1).read_until(b'\n', &mut buf).await?;
    if read == 0 {
        return Ok(BoundedLine::Eof);
    }
    if buf.last() == Some(&b'\n') {
        buf.pop();
        if buf.last() == Some(&b'\r') {
            buf.pop();
        }
    } else if buf.len() > max {
        return Ok(BoundedLine::TooLong);
    }
    Ok(BoundedLine::Line(String::from_utf8_lossy(&buf).into_owned()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::BufReader;

    #[tokio::test]
    async fn reads_lines_and_stops_at_the_cap() {
        let mut r = BufReader::new(&b"ab\r\ncd\n0123456789"[..]);
        assert_eq!(read_bounded_line(&mut r, 8).await.unwrap(), BoundedLine::Line("ab".into()));
        assert_eq!(read_bounded_line(&mut r, 8).await.unwrap(), BoundedLine::Line("cd".into()));
        assert_eq!(read_bounded_line(&mut r, 8).await.unwrap(), BoundedLine::TooLong);
    }

    #[tokio::test]
    async fn returns_a_final_unterminated_line_then_eof() {
        let mut r = BufReader::new(&b"tail"[..]);
        assert_eq!(read_bounded_line(&mut r, 8).await.unwrap(), BoundedLine::Line("tail".into()));
        assert_eq!(read_bounded_line(&mut r, 8).await.unwrap(), BoundedLine::Eof);
    }
}
