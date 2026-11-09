//! Input validators. Mirrors packages/shared/src/ids.ts (no regex crate in wasm).

/// An agent's name, the first label of `<name>.<marketplace contract>`:
/// 2..=32 chars of `a-z0-9`, with single `-` or `_` only between them
/// (a subset of NEAR's account-id label rules).
pub fn is_agent_name(s: &str) -> bool {
    let b = s.as_bytes();
    let sep = |c: u8| c == b'-' || c == b'_';
    (2..=32).contains(&b.len())
        && b.iter().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || sep(*c))
        && !sep(b[0])
        && !sep(b[b.len() - 1])
        && !b.windows(2).any(|w| sep(w[0]) && sep(w[1]))
}

/// `^[a-z][a-z0-9-]{2,63}$`
pub fn is_entity_id(s: &str) -> bool {
    let b = s.as_bytes();
    (3..=64).contains(&b.len())
        && b[0].is_ascii_lowercase()
        && b.iter().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'-')
}

/// 64 lowercase hex chars -> 32 bytes.
pub fn parse_hex32(s: &str) -> Option<[u8; 32]> {
    let b = s.as_bytes();
    if b.len() != 64 {
        return None;
    }
    let nib = |c: u8| match c {
        b'0'..=b'9' => Some(c - b'0'),
        b'a'..=b'f' => Some(c - b'a' + 10),
        _ => None,
    };
    let mut out = [0u8; 32];
    for i in 0..32 {
        out[i] = (nib(b[2 * i])? << 4) | nib(b[2 * i + 1])?;
    }
    Some(out)
}

pub fn to_hex(bytes: &[u8]) -> String {
    const H: &[u8; 16] = b"0123456789abcdef";
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push(H[(b >> 4) as usize] as char);
        s.push(H[(b & 0xf) as usize] as char);
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids() {
        assert!(is_agent_name("alice"));
        assert!(is_agent_name("buyer-1"));
        assert!(is_agent_name("gpu_farm-02"));
        assert!(!is_agent_name("a"));
        assert!(!is_agent_name(&"a".repeat(33)));
        assert!(!is_agent_name("Alice"));
        assert!(!is_agent_name("-alice"));
        assert!(!is_agent_name("alice-"));
        assert!(!is_agent_name("al--ice"));
        assert!(!is_agent_name("al.ice"));
        assert!(is_entity_id("auction-0001"));
        assert!(!is_entity_id("Auction-1"));
        assert!(!is_entity_id("ab"));
        assert!(!is_entity_id("1abc"));
        assert!(!is_entity_id(&"a".repeat(65)));
    }

    #[test]
    fn hex_roundtrip() {
        let h = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";
        let b = parse_hex32(h).unwrap();
        assert_eq!(b[31], 31);
        assert_eq!(to_hex(&b), h);
        assert!(parse_hex32(&h.to_uppercase()).is_none());
        assert!(parse_hex32(&h[..62]).is_none());
    }
}
