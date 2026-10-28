// Plain HTTP to the local dashboard server. It's on 127.0.0.1 and answers with small JSON bodies, so a bare
// HTTP/1.0 exchange over a TcpStream does, without pulling in an HTTP client.

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::time::Duration;

use serde_json::Value;

fn request(port: u16, method: &str, path: &str, body: Option<&Value>, wait: Duration) -> Option<(u16, String)> {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let mut stream = TcpStream::connect_timeout(&addr, Duration::from_secs(1)).ok()?;
    stream.set_read_timeout(Some(wait)).ok()?;
    let body = body.map(Value::to_string).unwrap_or_default();
    // Writes need the `x-dashboard` header (the server's guard against other websites).
    write!(
        stream,
        "{method} {path} HTTP/1.0\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\nx-dashboard: 1\r\n\
         Content-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
        body.len()
    )
    .ok()?;
    let mut raw = Vec::new();
    stream.read_to_end(&mut raw).ok()?;
    let text = String::from_utf8(raw).ok()?;
    let (head, body) = text.split_once("\r\n\r\n")?;
    let status = head.split_whitespace().nth(1)?.parse().ok()?;
    Some((status, body.to_string()))
}

/// `GET path`, parsed as JSON; None if the server is down or answers with an error.
pub fn get(port: u16, path: &str) -> Option<Value> {
    match request(port, "GET", path, None, Duration::from_secs(5))? {
        (200, body) => serde_json::from_str(&body).ok(),
        _ => None,
    }
}

/// `PUT path` with a JSON body; whether the server accepted it.
pub fn put(port: u16, path: &str, body: &Value) -> bool {
    matches!(request(port, "PUT", path, Some(body), Duration::from_secs(5)), Some((200..=299, _)))
}

/// `POST path` with a JSON body, waiting up to `wait` for the answer; whether the server accepted it.
pub fn post(port: u16, path: &str, body: &Value, wait: Duration) -> bool {
    matches!(request(port, "POST", path, Some(body), wait), Some((200..=299, _)))
}
