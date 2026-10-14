//! What this PC has for running a model: memory, graphics cards (with their own video memory) and processor threads.
//! Read-only: Windows' memory status, DXGI's adapter list and the free space of a drive. Nothing is started.

use std::path::Path;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Gpu {
    pub name: String,
    /// `nvidia`, `amd`, `intel` or `other`.
    pub vendor: String,
    /// Dedicated video memory. An integrated GPU has little or none (it shares the system memory).
    pub vram_bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Hardware {
    pub total_ram_bytes: u64,
    pub available_ram_bytes: u64,
    pub gpus: Vec<Gpu>,
    pub cpu_threads: u32,
    /// AVX2 makes the processor path of llama.cpp several times faster.
    pub avx2: bool,
}

impl Hardware {
    /// The graphics card with the most video memory.
    pub fn best_gpu(&self) -> Option<&Gpu> {
        self.gpus.iter().max_by_key(|g| g.vram_bytes)
    }

    pub fn vram_bytes(&self) -> u64 {
        self.best_gpu().map_or(0, |g| g.vram_bytes)
    }
}

pub fn vendor_name(vendor_id: u32) -> &'static str {
    match vendor_id {
        0x10DE => "nvidia",
        0x1002 | 0x1022 => "amd",
        0x8086 => "intel",
        _ => "other",
    }
}

fn avx2() -> bool {
    #[cfg(target_arch = "x86_64")]
    {
        std::arch::is_x86_feature_detected!("avx2")
    }
    #[cfg(not(target_arch = "x86_64"))]
    {
        false
    }
}

pub fn detect() -> Hardware {
    let (total_ram_bytes, available_ram_bytes) = sys::memory();
    Hardware {
        total_ram_bytes,
        available_ram_bytes,
        gpus: sys::gpus(),
        cpu_threads: std::thread::available_parallelism().map_or(1, |n| n.get() as u32),
        avx2: avx2(),
    }
}

/// Free bytes for this user on the drive holding `path` (its nearest existing folder). `None` when it can't be read.
pub fn free_disk_bytes(path: &Path) -> Option<u64> {
    let mut probe = path;
    while !probe.exists() {
        probe = probe.parent()?;
    }
    sys::free_disk(probe)
}

#[cfg(windows)]
mod sys {
    use std::os::windows::ffi::OsStrExt;
    use std::path::Path;
    use std::ptr;

    use winapi::shared::dxgi::{
        CreateDXGIFactory1, IDXGIAdapter1, IDXGIFactory1, DXGI_ADAPTER_DESC1,
        DXGI_ADAPTER_FLAG_SOFTWARE,
    };
    use winapi::shared::winerror::SUCCEEDED;
    use winapi::um::fileapi::GetDiskFreeSpaceExW;
    use winapi::um::sysinfoapi::{GlobalMemoryStatusEx, MEMORYSTATUSEX};
    use winapi::um::winnt::ULARGE_INTEGER;
    use winapi::Interface;

    use super::{vendor_name, Gpu};

    pub fn memory() -> (u64, u64) {
        // SAFETY: a zeroed MEMORYSTATUSEX with dwLength set is what GlobalMemoryStatusEx expects.
        let mut status: MEMORYSTATUSEX = unsafe { std::mem::zeroed() };
        status.dwLength = std::mem::size_of::<MEMORYSTATUSEX>() as u32;
        // SAFETY: `status` is valid for writes for the duration of the call.
        if unsafe { GlobalMemoryStatusEx(&mut status) } == 0 {
            return (0, 0);
        }
        (status.ullTotalPhys, status.ullAvailPhys)
    }

    pub fn gpus() -> Vec<Gpu> {
        let mut factory: *mut IDXGIFactory1 = ptr::null_mut();
        // SAFETY: the out pointer receives an IDXGIFactory1 (the IID asked for) or stays null on failure.
        let hr = unsafe {
            CreateDXGIFactory1(&IDXGIFactory1::uuidof(), &mut factory as *mut _ as *mut _)
        };
        if !SUCCEEDED(hr) || factory.is_null() {
            return Vec::new();
        }
        let mut found = Vec::new();
        for index in 0..16u32 {
            let mut adapter: *mut IDXGIAdapter1 = ptr::null_mut();
            // SAFETY: `factory` is a live factory; EnumAdapters1 fails (ending the loop) past the last adapter.
            let hr = unsafe { (*factory).EnumAdapters1(index, &mut adapter) };
            if !SUCCEEDED(hr) || adapter.is_null() {
                break;
            }
            // SAFETY: a zeroed descriptor is a valid out parameter; `adapter` is live until released below.
            let mut desc: DXGI_ADAPTER_DESC1 = unsafe { std::mem::zeroed() };
            let ok = SUCCEEDED(unsafe { (*adapter).GetDesc1(&mut desc) });
            // SAFETY: each COM pointer is released exactly once.
            unsafe { (*adapter).Release() };
            if !ok || desc.Flags & DXGI_ADAPTER_FLAG_SOFTWARE != 0 {
                continue;
            }
            let len = desc.Description.iter().position(|&c| c == 0).unwrap_or(0);
            found.push(Gpu {
                name: String::from_utf16_lossy(&desc.Description[..len])
                    .trim()
                    .to_string(),
                vendor: vendor_name(desc.VendorId).to_string(),
                vram_bytes: desc.DedicatedVideoMemory as u64,
            });
        }
        // SAFETY: released once, after the last use.
        unsafe { (*factory).Release() };
        found
    }

    pub fn free_disk(path: &Path) -> Option<u64> {
        let wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
        // SAFETY: zeroed ULARGE_INTEGERs are valid out parameters; `wide` is NUL-terminated and outlives the call.
        let mut free: ULARGE_INTEGER = unsafe { std::mem::zeroed() };
        let ok = unsafe {
            GetDiskFreeSpaceExW(wide.as_ptr(), &mut free, ptr::null_mut(), ptr::null_mut())
        };
        // SAFETY: the union holds a u64 after a successful call.
        (ok != 0).then(|| unsafe { *free.QuadPart() })
    }
}

#[cfg(not(windows))]
mod sys {
    use std::path::Path;

    use super::Gpu;

    fn meminfo(key: &str, text: &str) -> u64 {
        text.lines()
            .find_map(|line| line.strip_prefix(key))
            .and_then(|rest| rest.split_whitespace().next())
            .and_then(|kb| kb.parse::<u64>().ok())
            .map_or(0, |kb| kb * 1024)
    }

    pub fn memory() -> (u64, u64) {
        let text = std::fs::read_to_string("/proc/meminfo").unwrap_or_default();
        (meminfo("MemTotal:", &text), meminfo("MemAvailable:", &text))
    }

    pub fn gpus() -> Vec<Gpu> {
        Vec::new()
    }

    pub fn free_disk(_path: &Path) -> Option<u64> {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vendors_are_named_from_their_pci_id() {
        assert_eq!(vendor_name(0x10DE), "nvidia");
        assert_eq!(vendor_name(0x1002), "amd");
        assert_eq!(vendor_name(0x8086), "intel");
        assert_eq!(vendor_name(0x1234), "other");
    }

    #[test]
    fn this_pc_reports_its_memory_and_threads() {
        let hw = detect();
        assert!(hw.cpu_threads >= 1);
        #[cfg(windows)]
        assert!(hw.total_ram_bytes > 512 * 1024 * 1024);
        assert!(hw.available_ram_bytes <= hw.total_ram_bytes);
    }

    #[test]
    fn free_space_is_read_from_the_nearest_existing_folder() {
        let dir = tempfile::tempdir().expect("tmp");
        let missing = dir.path().join("models").join("x");
        #[cfg(windows)]
        assert!(free_disk_bytes(&missing).is_some_and(|b| b > 0));
        #[cfg(not(windows))]
        let _ = free_disk_bytes(&missing);
    }
}
