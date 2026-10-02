#![cfg(windows)]

//! Windows-only: ensures killing a process kills its whole process tree
//! (the process plus everything it spawned), not just the process itself. Used
//! by terminals (the shell) and by Run Code (the interpreter).
//!
//! `portable-pty`'s own `Child::kill()` only calls `TerminateProcess` on the
//! direct child process (see its `win/mod.rs`) — it has no idea about
//! anything that process goes on to spawn, so a `node`/`python`/etc. process
//! started from inside the shell would survive the shell being killed and
//! become an orphan. A Windows Job Object fixes this: every process ever
//! assigned to the job (children inherit job membership automatically
//! unless they explicitly opt out, which ordinary shells don't) dies when
//! `TerminateJobObject` is called — and, because this job is created with
//! `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, the same thing happens automatically
//! if the job handle itself is ever dropped without an explicit terminate
//! (e.g. the app crashing instead of shutting down cleanly).

use std::io;
use std::os::windows::io::{AsRawHandle, FromRawHandle, RawHandle};

use filedescriptor::OwnedHandle;
use winapi::um::jobapi2::TerminateJobObject;
use winapi::um::jobapi2::{
    AssignProcessToJobObject, CreateJobObjectW, QueryInformationJobObject, SetInformationJobObject,
};
use winapi::um::winnt::{
    JobObjectBasicAccountingInformation, JobObjectExtendedLimitInformation,
    JOBOBJECT_BASIC_ACCOUNTING_INFORMATION, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};

pub struct ProcessTree {
    job: OwnedHandle,
}

impl ProcessTree {
    pub fn new() -> io::Result<Self> {
        // SAFETY: `CreateJobObjectW` with null attributes/name is the
        // documented way to create an anonymous, process-local job object;
        // the returned handle is checked for null (failure) before use.
        let handle = unsafe { CreateJobObjectW(std::ptr::null_mut(), std::ptr::null()) };
        if handle.is_null() {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: `handle` was just returned by `CreateJobObjectW` above and
        // is not owned anywhere else yet.
        let job = unsafe { OwnedHandle::from_raw_handle(handle as RawHandle) };

        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        // SAFETY: `info` is a validly-initialized (zeroed, then one field
        // set) instance of the struct type this call expects, and its size
        // matches the length argument.
        let ok = unsafe {
            SetInformationJobObject(
                job.as_raw_handle() as _,
                JobObjectExtendedLimitInformation,
                std::ptr::addr_of_mut!(info) as _,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        };
        if ok == 0 {
            return Err(io::Error::last_os_error());
        }

        Ok(Self { job })
    }

    /// Puts the process behind `process_handle` — and, transitively,
    /// whatever it later spawns — under this job. Must be called before the
    /// process has a chance to spawn children of its own, i.e. right after
    /// the shell is spawned.
    pub fn assign(&self, process_handle: RawHandle) -> io::Result<()> {
        // SAFETY: `process_handle` is a valid process handle owned by the
        // caller (portable-pty's `Child`) for at least the duration of this
        // call, and `self.job` is a valid job object handle.
        let ok =
            unsafe { AssignProcessToJobObject(self.job.as_raw_handle() as _, process_handle as _) };
        if ok == 0 {
            Err(io::Error::last_os_error())
        } else {
            Ok(())
        }
    }

    /// How many processes are alive in the tree right now (the first process plus everything it started that is
    /// still running): a shell sitting at its prompt counts 1.
    pub fn active_processes(&self) -> io::Result<u32> {
        let mut info: JOBOBJECT_BASIC_ACCOUNTING_INFORMATION = unsafe { std::mem::zeroed() };
        // SAFETY: `self.job` is a valid job object handle; `info` is a zeroed instance of the struct this information
        // class fills, and the length argument is its size.
        let ok = unsafe {
            QueryInformationJobObject(
                self.job.as_raw_handle() as _,
                JobObjectBasicAccountingInformation,
                std::ptr::addr_of_mut!(info) as _,
                std::mem::size_of::<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>() as u32,
                std::ptr::null_mut(),
            )
        };
        if ok == 0 {
            Err(io::Error::last_os_error())
        } else {
            Ok(info.ActiveProcesses)
        }
    }

    /// Kills every process in the tree immediately.
    pub fn terminate(&self) {
        // SAFETY: `self.job` is a valid job object handle for the lifetime
        // of `self`; the exit code (1) is an arbitrary non-zero value, same
        // as portable-pty's own `TerminateProcess` calls use.
        unsafe {
            TerminateJobObject(self.job.as_raw_handle() as _, 1);
        }
    }
}
