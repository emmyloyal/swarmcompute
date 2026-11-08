//! Input validators. Mirrors packages/shared/src/ids.ts (no regex crate in wasm).

pub fn is_buyer_id(s: &str) -> bool {
    matches!(s.strip_prefix("buyer-"), Some(d) if d.len() == 3 && d.bytes().all(|b| b.is_ascii_digit()))
}

pub fn is_seller_id(s: &str) -> bool {
    matches!(s.strip_prefix("seller-"), Some(d) if d.len() == 2 && d.bytes().all(|b| b.is_ascii_digit()))
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
        assert!(is_buyer_id("buyer-001"));
        assert!(!is_buyer_id("buyer-01"));
        assert!(!is_buyer_id("buyer-0a1"));
        assert!(is_seller_id("seller-05"));
        assert!(!is_seller_id("seller-005"));
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
