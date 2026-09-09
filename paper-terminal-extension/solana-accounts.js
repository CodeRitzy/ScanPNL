// Binary/PDA routines adapted from PaperTrench (MIT). See third-party/PaperTrench-LICENSE.txt.
// Network observations and strict owner/layout checks live in solana-quotes.js.
(() => {
  const MINT_SUPPLY=36,MINT_DECIMALS=44,SPL_MINT=0,SPL_AMOUNT=64;
  function bytesFromBase64(b64) {
    if (typeof b64 !== 'string') return null;
    try {
      const bin = atob(b64);
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    } catch (_) {
      return null;
    }
  }

  /**
   * u64 little-endian as a JS number.
   *
   * Raw token amounts can exceed 2^53, so this is assembled from two 32-bit
   * halves rather than via BigInt (kept dependency-free and fast). Precision
   * beyond 2^53 is irrelevant here: the value is immediately divided by
   * 10^decimals to produce a UI amount, and a price only needs ~15 significant
   * digits.
   */
  function readU64(bytes, offset) {
    if (!bytes || offset + 8 > bytes.length) return null;
    let lo = 0;
    let hi = 0;
    for (let i = 3; i >= 0; i--) lo = lo * 256 + bytes[offset + i];
    for (let i = 7; i >= 4; i--) hi = hi * 256 + bytes[offset + i];
    return hi * 4294967296 + lo;
  }

  /** u128 little-endian as a JS number (used only for sqrtPrice). */
  function readU128(bytes, offset) {
    if (!bytes || offset + 16 > bytes.length) return null;
    let value = 0;
    for (let i = 15; i >= 0; i--) value = value * 256 + bytes[offset + i];
    return value;
  }

  const B58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

  /**
   * Base58-encode a 32-byte pubkey slice.
   *
   * Scanning a pool account byte-by-byte produces mostly garbage slices. An
   * all-zero slice is the system program and never a vault, and RPC rejects a
   * malformed key outright ("Invalid param: WrongSize"), so those are filtered
   * here rather than being sent upstream.
   */
  function readPubkey(bytes, offset) {
    if (!bytes || offset + 32 > bytes.length) return null;
    let allZero = true;
    for (let i = 0; i < 32; i++) {
      if (bytes[offset + i] !== 0) { allZero = false; break; }
    }
    if (allZero) return null;
    const digits = [0];
    for (let i = 0; i < 32; i++) {
      let carry = bytes[offset + i];
      for (let j = 0; j < digits.length; j++) {
        carry += digits[j] << 8;
        digits[j] = carry % 58;
        carry = (carry / 58) | 0;
      }
      while (carry > 0) { digits.push(carry % 58); carry = (carry / 58) | 0; }
    }
    let out = '';
    for (let i = 0; i < 32 && bytes[offset + i] === 0; i++) out += '1';
    for (let i = digits.length - 1; i >= 0; i--) out += B58_ALPHABET[digits[i]];
    // A real 32-byte key is 32-44 base58 characters. Anything else is a
    // misaligned slice, not an account.
    return out.length >= 32 && out.length <= 44 ? out : null;
  }

  /* ---------------- pump.fun bonding-curve derivation ----------------
   *
   * A brand-new pump.fun coin exists on-chain minutes before any aggregator
   * indexes it — and its bonding-curve account address is fully DERIVABLE:
   * findProgramAddress(["bonding-curve", mint], pumpProgram). Deriving it is
   * what lets the feed stream a real chain price for a coin whose page shows
   * the pantsless wait-state (the sniping case, reported by the maintainer
   * on a 39-second-old Axiom launch).
   *
   * PDA rules (verified against five live mainnet curve accounts before this
   * shipped): sha256(seeds ‖ bump ‖ programId ‖ "ProgramDerivedAddress"),
   * bump from 255 downward, first hash that is NOT an ed25519 point wins.
   * The on-curve check decompresses the candidate as a point: x² = (y²-1) /
   * (d·y²+1) over GF(2²⁵⁵−19); a solvable x means "on curve" (reject bump).
   */

  function b58decode(s) {
    if (typeof s !== 'string' || !s.length) return null;
    let n = 0n;
    for (const c of s) {
      const i = B58_ALPHABET.indexOf(c);
      if (i < 0) return null;
      n = n * 58n + BigInt(i);
    }
    const out = [];
    while (n > 0n) { out.push(Number(n & 0xffn)); n >>= 8n; }
    for (const c of s) { if (c === '1') out.push(0); else break; }
    const bytes = Uint8Array.from(out.reverse());
    return bytes.length === 32 ? bytes : null;
  }

  const ED_P = 2n ** 255n - 19n;
  const ED_D = 37095705934669439343138083508754565189542113879843219016388785533085940283555n;

  function modpow(b, e, m) {
    let r = 1n;
    b %= m;
    while (e > 0n) {
      if (e & 1n) r = (r * b) % m;
      b = (b * b) % m;
      e >>= 1n;
    }
    return r;
  }

  /** True when 32 bytes decompress to a valid ed25519 point. */
  function isOnCurve(bytes) {
    let y = 0n;
    for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(bytes[i]);
    y &= (1n << 255n) - 1n; // strip the x-sign bit
    if (y >= ED_P) return false;
    const y2 = (y * y) % ED_P;
    const u = (y2 - 1n + ED_P) % ED_P;
    const v = (ED_D * y2 + 1n) % ED_P;
    // Candidate root x = uv³·(uv⁷)^((p−5)/8); valid iff v·x² = ±u (the −u
    // case is fixed up by the √−1 multiple, still a valid point).
    const v3 = (v * v % ED_P) * v % ED_P;
    const v7 = (v3 * v3 % ED_P) * v % ED_P;
    const x = (u * v3 % ED_P) * modpow((u * v7) % ED_P, (ED_P - 5n) / 8n, ED_P) % ED_P;
    const vxx = (v * x % ED_P) * x % ED_P;
    return vxx === u || vxx === (ED_P - u) % ED_P;
  }

  const PUMP_PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
  // Plain charCode bytes, not TextEncoder: this file loads in every world
  // (worker, content, node test sandboxes) and must not assume web globals.
  function asciiBytes(s) {
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  }
  const PDA_MARKER = asciiBytes('ProgramDerivedAddress');
  const CURVE_SEED = asciiBytes('bonding-curve');

  /** The pump.fun bonding-curve address for a mint, or null. Async because
   * sha256 comes from crypto.subtle (the only digest a worker has). */
  async function derivePumpCurve(mintBase58) {
    const mint = b58decode(mintBase58);
    const program = b58decode(PUMP_PROGRAM);
    const subtle = (typeof crypto !== 'undefined' && crypto.subtle) || null;
    if (!mint || !program || !subtle) return null;
    const buf = new Uint8Array(CURVE_SEED.length + mint.length + 1 + program.length + PDA_MARKER.length);
    buf.set(CURVE_SEED, 0);
    buf.set(mint, CURVE_SEED.length);
    const bumpAt = CURVE_SEED.length + mint.length;
    buf.set(program, bumpAt + 1);
    buf.set(PDA_MARKER, bumpAt + 1 + program.length);
    for (let bump = 255; bump >= 0; bump--) {
      buf[bumpAt] = bump;
      const hash = new Uint8Array(await subtle.digest('SHA-256', buf));
      if (!isOnCurve(hash)) return readPubkey(hash, 0);
    }
    return null;
  }

  /* ---------------- account decoders ---------------- */

  /** Mint account -> { decimals, supply }. */
  function decodeMint(bytes) {
    if (!bytes || bytes.length < 45) return null;
    return {
      decimals: bytes[MINT_DECIMALS],
      supply: readU64(bytes, MINT_SUPPLY),
    };
  }

  /** SPL token account -> { mint, amount }. Both token programs share this base. */
  function decodeTokenAccount(bytes) {
    if (!bytes || bytes.length < 165) return null;
    return {
      mint: readPubkey(bytes, SPL_MINT),
      amount: readU64(bytes, SPL_AMOUNT),
    };
  }


  globalThis.SolanaAccounts={bytesFromBase64,readU64,readPubkey,b58decode,decodeMint,decodeTokenAccount,derivePumpCurve,PUMP_PROGRAM};
})();
