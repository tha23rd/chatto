// SPDX-License-Identifier: AGPL-3.0-or-later

use base64::{engine::general_purpose::STANDARD, Engine as _};
use minisign_verify::{PublicKey, Signature};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let arguments: Vec<String> = std::env::args().collect();
    if arguments.len() != 4 {
        return Err("usage: verify-updater-signature <installer> <signature> <public-key>".into());
    }

    let installer = std::fs::read(&arguments[1])?;
    let encoded_signature = std::fs::read_to_string(&arguments[2])?;
    let public_key_text = String::from_utf8(STANDARD.decode(arguments[3].trim())?)?;
    let signature_text = String::from_utf8(STANDARD.decode(encoded_signature.trim())?)?;

    let public_key = PublicKey::decode(&public_key_text)?;
    let signature = Signature::decode(&signature_text)?;
    public_key.verify(&installer, &signature, true)?;
    Ok(())
}
