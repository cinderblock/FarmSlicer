//! Structural checks on a package before anything reads it.
//!
//! What we check and what the printer runs must be the same bytes. The `zip`
//! crate indexes entries by name and lets a later duplicate win silently; a
//! printer's unzipper may take the first, or read local headers in order and
//! find entries the central directory doesn't list. So the package is
//! refused unless its central directory is unambiguous and accounts for every
//! byte before it:
//!
//! - entry names are unique (also ignoring case and `\` vs `/`), relative,
//!   without `..`, control characters or odd encodings;
//! - every entry is stored or deflated, not encrypted;
//! - the local headers, laid end to end in offset order, start at byte 0,
//!   leave no gaps, carry the same names as the central directory, and end
//!   where the central directory begins.

use std::collections::HashSet;
use std::io::{Read, Seek, SeekFrom};

/// More entries than any sliced project has (a plate has about ten).
const MAX_ENTRIES: usize = 10_000;

#[derive(Debug, Clone)]
pub struct Entry {
    pub name: String,
    pub method: u16,
    pub flags: u16,
    pub compressed_size: u64,
    pub uncompressed_size: u64,
    pub local_offset: u64,
}

fn u16_at(b: &[u8], i: usize) -> u16 {
    u16::from_le_bytes([b[i], b[i + 1]])
}
fn u32_at(b: &[u8], i: usize) -> u32 {
    u32::from_le_bytes(b[i..i + 4].try_into().unwrap())
}
fn u64_at(b: &[u8], i: usize) -> u64 {
    u64::from_le_bytes(b[i..i + 8].try_into().unwrap())
}

fn read_exact_at<R: Read + Seek>(r: &mut R, offset: u64, len: usize) -> Result<Vec<u8>, String> {
    r.seek(SeekFrom::Start(offset)).map_err(|e| e.to_string())?;
    let mut buf = vec![0; len];
    r.read_exact(&mut buf).map_err(|_| "the zip archive is truncated".to_string())?;
    Ok(buf)
}

/// Where the central directory lives and how many entries it has.
struct Directory {
    offset: u64,
    size: u64,
    entries: u64,
}

fn find_directory<R: Read + Seek>(r: &mut R, file_len: u64) -> Result<Directory, String> {
    // The end-of-central-directory record is 22 bytes plus a comment of up
    // to 64 KiB, at the very end.
    let tail_len = file_len.min(22 + 65_535) as usize;
    let tail = read_exact_at(r, file_len - tail_len as u64, tail_len)?;
    let pos = (0..=tail_len.saturating_sub(22))
        .rev()
        .find(|&i| u32_at(&tail, i) == 0x0605_4b50 && i + 22 + u16_at(&tail, i + 20) as usize == tail_len)
        .ok_or("this isn't a 3MF file (not a zip archive)")?;
    let eocd_at = file_len - tail_len as u64 + pos as u64;
    let e = &tail[pos..];
    if u16_at(e, 4) != 0 || u16_at(e, 6) != 0 || u16_at(e, 8) != u16_at(e, 10) {
        return Err("multi-part zip archives aren't supported".into());
    }
    let mut dir = Directory { offset: u32_at(e, 16) as u64, size: u32_at(e, 12) as u64, entries: u16_at(e, 10) as u64 };
    if dir.offset == 0xFFFF_FFFF || dir.size == 0xFFFF_FFFF || dir.entries == 0xFFFF {
        // Zip64: the locator sits right before the classic record.
        if eocd_at < 20 {
            return Err("the zip archive is truncated".into());
        }
        let loc = read_exact_at(r, eocd_at - 20, 20)?;
        if u32_at(&loc, 0) != 0x0706_4b50 {
            return Err("the zip archive's directory is damaged".into());
        }
        let z = read_exact_at(r, u64_at(&loc, 8), 56)?;
        if u32_at(&z, 0) != 0x0606_4b50 {
            return Err("the zip archive's directory is damaged".into());
        }
        dir = Directory { offset: u64_at(&z, 48), size: u64_at(&z, 40), entries: u64_at(&z, 32) };
        if dir.offset.checked_add(dir.size).is_none_or(|end| end > eocd_at - 20) {
            return Err("the zip archive's directory is damaged".into());
        }
    } else if dir.offset + dir.size != eocd_at {
        return Err("the zip archive has data between its directory and its end".into());
    }
    Ok(dir)
}

fn zip64_sizes(extra: &[u8], e: &mut Entry, need_u: bool, need_c: bool, need_o: bool) -> Result<(), String> {
    let mut i = 0;
    while i + 4 <= extra.len() {
        let id = u16_at(extra, i);
        let len = u16_at(extra, i + 2) as usize;
        let body = extra.get(i + 4..i + 4 + len).ok_or("a zip entry's extra field is damaged")?;
        if id == 0x0001 {
            let mut j = 0;
            let mut take = |want: bool, slot: &mut u64| -> Result<(), String> {
                if want {
                    *slot = u64_at(body.get(j..j + 8).ok_or("a zip entry's zip64 field is damaged")?, 0);
                    j += 8;
                }
                Ok(())
            };
            take(need_u, &mut e.uncompressed_size)?;
            take(need_c, &mut e.compressed_size)?;
            take(need_o, &mut e.local_offset)?;
            return Ok(());
        }
        i += 4 + len;
    }
    if need_u || need_c || need_o {
        return Err("a zip entry's zip64 field is missing".into());
    }
    Ok(())
}

fn check_name(name: &str) -> Result<(), String> {
    let bad = name.is_empty()
        || name.len() > 512
        || name.starts_with('/')
        || name.contains('\\')
        || name.contains(':')
        || name.chars().any(|c| c.is_control())
        || name.split('/').any(|seg| seg == ".." || seg == ".");
    if bad {
        return Err(format!("the package has an entry with an unusable name ({name:?})"));
    }
    Ok(())
}

/// Read and verify the central directory. The entries come back in
/// directory order.
pub fn verify<R: Read + Seek>(r: &mut R) -> Result<Vec<Entry>, String> {
    let file_len = r.seek(SeekFrom::End(0)).map_err(|e| e.to_string())?;
    if file_len < 22 {
        return Err("this isn't a 3MF file (not a zip archive)".into());
    }
    let dir = find_directory(r, file_len)?;
    if dir.entries as usize > MAX_ENTRIES || dir.size > 64 * 1024 * 1024 {
        return Err("the package has too many entries".into());
    }
    let cd = read_exact_at(r, dir.offset, dir.size as usize)?;

    let mut entries = Vec::new();
    let mut seen = HashSet::new();
    let mut i = 0;
    while i < cd.len() {
        if i + 46 > cd.len() || u32_at(&cd, i) != 0x0201_4b50 {
            return Err("the zip archive's directory is damaged".into());
        }
        let flags = u16_at(&cd, i + 8);
        let method = u16_at(&cd, i + 10);
        let name_len = u16_at(&cd, i + 28) as usize;
        let extra_len = u16_at(&cd, i + 30) as usize;
        let comment_len = u16_at(&cd, i + 32) as usize;
        let disk = u16_at(&cd, i + 34);
        let end = i + 46 + name_len + extra_len + comment_len;
        if end > cd.len() || disk != 0 {
            return Err("the zip archive's directory is damaged".into());
        }
        let raw_name = &cd[i + 46..i + 46 + name_len];
        let name = std::str::from_utf8(raw_name)
            .map_err(|_| "the package has an entry whose name isn't UTF-8".to_string())?
            .to_string();
        // Bit 11 = UTF-8 names; without it the name is CP437, which only
        // agrees with UTF-8 for ASCII.
        if flags & 0x0800 == 0 && !name.is_ascii() {
            return Err(format!("the package has an entry with an ambiguous name ({name:?})"));
        }
        check_name(&name)?;
        if !seen.insert(name.to_lowercase()) {
            return Err(format!("the package has two entries called {name:?}"));
        }
        if flags & 0x0001 != 0 || flags & 0x0040 != 0 {
            return Err(format!("{name} is encrypted"));
        }
        if method != 0 && method != 8 {
            return Err(format!("{name} uses an unsupported compression method ({method})"));
        }
        let mut e = Entry {
            name,
            method,
            flags,
            compressed_size: u32_at(&cd, i + 20) as u64,
            uncompressed_size: u32_at(&cd, i + 24) as u64,
            local_offset: u32_at(&cd, i + 42) as u64,
        };
        let (need_u, need_c, need_o) = (
            e.uncompressed_size == 0xFFFF_FFFF,
            e.compressed_size == 0xFFFF_FFFF,
            e.local_offset == 0xFFFF_FFFF,
        );
        zip64_sizes(&cd[i + 46 + name_len..i + 46 + name_len + extra_len], &mut e, need_u, need_c, need_o)?;
        entries.push(e);
        i = end;
    }
    if entries.len() as u64 != dir.entries {
        return Err("the zip archive's directory is damaged".into());
    }

    // The local entries must tile the file from 0 to the directory.
    let mut order: Vec<&Entry> = entries.iter().collect();
    order.sort_by_key(|e| e.local_offset);
    let mut at = 0u64;
    for e in order {
        if e.local_offset != at {
            return Err("the package has data its directory doesn't account for".into());
        }
        let h = read_exact_at(r, e.local_offset, 30)?;
        if u32_at(&h, 0) != 0x0403_4b50 {
            return Err("the zip archive's entries are damaged".into());
        }
        let name_len = u16_at(&h, 26) as usize;
        let extra_len = u16_at(&h, 28) as usize;
        let local_name = read_exact_at(r, e.local_offset + 30, name_len)?;
        if local_name != e.name.as_bytes() {
            return Err(format!("{} is named differently inside the archive", e.name));
        }
        if u16_at(&h, 8) != e.method {
            return Err(format!("{} is stored two different ways", e.name));
        }
        let data_end = e.local_offset + 30 + name_len as u64 + extra_len as u64 + e.compressed_size;
        at = data_end;
        // A data descriptor follows when bit 3 is set: CRC and sizes, with
        // or without a signature, 32- or 64-bit sizes.
        if e.flags & 0x0008 != 0 {
            let room = dir.offset.saturating_sub(data_end).min(24) as usize;
            let d = read_exact_at(r, data_end, room)?;
            let signed = room >= 4 && u32_at(&d, 0) == 0x0807_4b50;
            let base = if signed { 4 } else { 0 };
            let sizes_ok = |wide: bool| -> bool {
                let need = base + 4 + if wide { 16 } else { 8 };
                need <= room
                    && if wide {
                        u64_at(&d, base + 4) == e.compressed_size && u64_at(&d, base + 12) == e.uncompressed_size
                    } else {
                        u32_at(&d, base + 4) as u64 == e.compressed_size && u32_at(&d, base + 8) as u64 == e.uncompressed_size
                    }
            };
            at += if sizes_ok(false) {
                (base + 12) as u64
            } else if sizes_ok(true) {
                (base + 20) as u64
            } else {
                return Err(format!("{}'s data descriptor is damaged", e.name));
            };
        }
    }
    if at != dir.offset {
        return Err("the package has data its directory doesn't account for".into());
    }
    Ok(entries)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Cursor, Write};

    fn build(entries: &[(&str, &[u8])]) -> Vec<u8> {
        let mut out = Cursor::new(Vec::new());
        let mut zip = zip::ZipWriter::new(&mut out);
        for (name, data) in entries {
            zip.start_file(*name, zip::write::SimpleFileOptions::default()).unwrap();
            zip.write_all(data).unwrap();
        }
        zip.finish().unwrap();
        out.into_inner()
    }

    /// A stored zip written by hand, so tests can break it on purpose.
    fn stored(entries: &[(&str, &[u8])], junk_before: &[u8]) -> Vec<u8> {
        let mut out = junk_before.to_vec();
        let mut central = Vec::new();
        for (name, data) in entries {
            let offset = out.len() as u32;
            let crc = crc32(data);
            out.extend_from_slice(&0x0403_4b50u32.to_le_bytes());
            out.extend_from_slice(&[20, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
            out.extend_from_slice(&crc.to_le_bytes());
            out.extend_from_slice(&(data.len() as u32).to_le_bytes());
            out.extend_from_slice(&(data.len() as u32).to_le_bytes());
            out.extend_from_slice(&(name.len() as u16).to_le_bytes());
            out.extend_from_slice(&[0, 0]);
            out.extend_from_slice(name.as_bytes());
            out.extend_from_slice(data);
            central.extend_from_slice(&0x0201_4b50u32.to_le_bytes());
            central.extend_from_slice(&[20, 0, 20, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
            central.extend_from_slice(&crc.to_le_bytes());
            central.extend_from_slice(&(data.len() as u32).to_le_bytes());
            central.extend_from_slice(&(data.len() as u32).to_le_bytes());
            central.extend_from_slice(&(name.len() as u16).to_le_bytes());
            central.extend_from_slice(&[0; 12]);
            central.extend_from_slice(&offset.to_le_bytes());
            central.extend_from_slice(name.as_bytes());
        }
        let cd_offset = out.len() as u32;
        out.extend_from_slice(&central);
        out.extend_from_slice(&0x0605_4b50u32.to_le_bytes());
        out.extend_from_slice(&[0, 0, 0, 0]);
        out.extend_from_slice(&(entries.len() as u16).to_le_bytes());
        out.extend_from_slice(&(entries.len() as u16).to_le_bytes());
        out.extend_from_slice(&(central.len() as u32).to_le_bytes());
        out.extend_from_slice(&cd_offset.to_le_bytes());
        out.extend_from_slice(&[0, 0]);
        out
    }

    fn crc32(data: &[u8]) -> u32 {
        let mut c = 0xffff_ffffu32;
        for &b in data {
            c ^= b as u32;
            for _ in 0..8 {
                c = if c & 1 != 0 { 0xedb8_8320 ^ (c >> 1) } else { c >> 1 };
            }
        }
        !c
    }

    #[test]
    fn accepts_ordinary_archives() {
        let z = build(&[("Metadata/plate_1.gcode", b"G28\n"), ("Metadata/slice_info.config", b"<config/>")]);
        let entries = verify(&mut Cursor::new(z)).unwrap();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].name, "Metadata/plate_1.gcode");
        assert!(verify(&mut Cursor::new(stored(&[("a", b"1"), ("b", b"22")], b""))).is_ok());
    }

    #[test]
    fn refuses_duplicates_and_hidden_data() {
        let dup = stored(&[("Metadata/plate_1.gcode", b"G28\n"), ("Metadata/plate_1.gcode", b"M104 S300\n")], b"");
        assert!(verify(&mut Cursor::new(dup)).unwrap_err().contains("two entries"));
        let case = stored(&[("Metadata/plate_1.gcode", b"G28\n"), ("metadata/PLATE_1.gcode", b"x")], b"");
        assert!(verify(&mut Cursor::new(case)).unwrap_err().contains("two entries"));
        // A local entry before the first listed one (a streaming reader would see it).
        let hidden = stored(&[("Metadata/plate_1.gcode", b"G28\n")], b"PK\x03\x04hidden entry bytes");
        assert!(verify(&mut Cursor::new(hidden)).unwrap_err().contains("doesn't account"));
    }

    #[test]
    fn refuses_odd_names() {
        for name in ["../plate_1.gcode", "/Metadata/plate_1.gcode", "Metadata\\plate_1.gcode", "Metadata/./plate_1.gcode", "a\nb"] {
            let z = stored(&[(name, b"x")], b"");
            assert!(verify(&mut Cursor::new(z)).is_err(), "{name:?}");
        }
    }

    #[test]
    fn refuses_non_zips_and_truncation() {
        assert!(verify(&mut Cursor::new(b"solid cube\nendsolid".to_vec())).is_err());
        let z = build(&[("a", b"1")]);
        assert!(verify(&mut Cursor::new(z[..z.len() - 5].to_vec())).is_err());
    }
}
