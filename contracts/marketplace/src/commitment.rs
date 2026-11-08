//! Bid commitment (spec Section 7, ARCHITECTURE.md §6). Byte-identical to
//! packages/shared/src/commitment.ts:
//!
//!   sha256( LP(auction_id) || LP(seller_id) || LP(price_be16) || LP(nonce) )
//!   LP(x) = u32 big-endian length of x, then x

use near_sdk::env;

fn push_lp(buf: &mut Vec<u8>, bytes: &[u8]) {
    buf.extend_from_slice(&(bytes.len() as u32).to_be_bytes());
    buf.extend_from_slice(bytes);
}

pub fn compute(auction_id: &str, seller_id: &str, price_per_hour: u128, nonce: &[u8; 32]) -> [u8; 32] {
    let mut buf = Vec::with_capacity(4 * 4 + auction_id.len() + seller_id.len() + 16 + 32);
    push_lp(&mut buf, auction_id.as_bytes());
    push_lp(&mut buf, seller_id.as_bytes());
    push_lp(&mut buf, &price_per_hour.to_be_bytes());
    push_lp(&mut buf, nonce);
    env::sha256_array(&buf)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::validate::to_hex;

    /// Shared test vector, ARCHITECTURE.md §6 (also tested in packages/shared).
    #[test]
    fn shared_test_vector() {
        let mut nonce = [0u8; 32];
        for (i, b) in nonce.iter_mut().enumerate() {
            *b = i as u8;
        }
        let c = compute("auction-0001", "seller-01", 1_000_000_000_000_000_000_000_000, &nonce);
        assert_eq!(to_hex(&c), "c80c9bf2feaea19846ff2eca8baacb87a274d7ad8eb08c30692cb515e651c2ee");
    }

    #[test]
    fn binds_every_field() {
        let n = [7u8; 32];
        let base = compute("auction-0001", "seller-01", 5, &n);
        assert_ne!(base, compute("auction-0002", "seller-01", 5, &n));
        assert_ne!(base, compute("auction-0001", "seller-02", 5, &n));
        assert_ne!(base, compute("auction-0001", "seller-01", 6, &n));
        assert_ne!(base, compute("auction-0001", "seller-01", 5, &[8u8; 32]));
    }
}
