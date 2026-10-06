//! Process trees for the CLI: start children in their own tree (a Job object
//! on Windows, a process group on Unix), bind a tree's lifetime to its
//! guard, and terminate or probe processes by pid.
#![deny(warnings)]

use std::io;

#[cfg(any(windows, test))]
fn process_birth_within_parent_lifetime(
    parent_created: u64,
    parent_exited: Option<u64>,
    child_created: u64,
) -> bool {
    parent_created > 0
        && child_created >= parent_created
        && parent_exited.is_none_or(|exit| exit >= parent_created && child_created <= exit)
}

#[cfg(test)]
mod lineage_tests {
    use super::process_birth_within_parent_lifetime as related;

    #[test]
    fn recycled_parent_pid_does_not_adopt_older_system_processes() {
        assert!(!related(900, None, 100));
        assert!(related(900, None, 901));
        assert!(!related(0, None, 100));
    }

    #[test]
    fn exited_parent_only_authorizes_children_born_during_its_lifetime() {
        assert!(related(100, Some(200), 150));
        assert!(!related(100, Some(200), 201));
        assert!(!related(100, Some(50), 125));
    }
}

#[cfg(windows)]
mod platform {
    use std::collections::{HashMap, HashSet, VecDeque};
    use std::io;
    use std::mem::size_of;
    use std::os::windows::ffi::OsStrExt as _;
    use std::os::windows::io::{AsHandle, AsRawHandle, FromRawHandle, OwnedHandle, RawHandle};
    use std::time::{Duration, Instant};

    use tokio::process::Child;
    use windows_sys::Win32::Foundation::{
        ERROR_ACCESS_DENIED, ERROR_INVALID_HANDLE, ERROR_INVALID_PARAMETER, ERROR_NO_MORE_FILES,
        FILETIME, GetLastError, HANDLE, INVALID_HANDLE_VALUE, LocalFree, WAIT_FAILED,
        WAIT_OBJECT_0, WAIT_TIMEOUT,
    };
    use windows_sys::Win32::Security::Authorization::{
        ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
    };
    use windows_sys::Win32::Security::{PSECURITY_DESCRIPTOR, SECURITY_ATTRIBUTES};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW,
        TH32CS_SNAPPROCESS,
    };
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation,
        SetInformationJobObject, TerminateJobObject,
    };
    use windows_sys::Win32::System::Threading::{
        GetCurrentProcess, GetProcessId, GetProcessTimes, IsProcessCritical, OpenProcess,
        PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE, PROCESS_TERMINATE,
        TerminateProcess, WaitForSingleObject,
    };

    const TREE_EXIT_CODE: u32 = 1;
    const TERMINATION_WAIT: Duration = Duration::from_secs(3);

    #[derive(Debug)]
    pub struct ProcessTreeGuard {
        job: Option<OwnedHandle>,
        detached_process: Option<io::Result<OwnedHandle>>,
        terminate_on_drop: bool,
    }

    impl ProcessTreeGuard {
        fn bind_handle(process: HANDLE) -> io::Result<Self> {
            Self::bind_handle_named(process, None)
        }

        fn bind_handle_named(process: HANDLE, name: Option<&[u16]>) -> io::Result<Self> {
            let mut descriptor: PSECURITY_DESCRIPTOR = std::ptr::null_mut();
            let mut security = SECURITY_ATTRIBUTES {
                nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
                lpSecurityDescriptor: std::ptr::null_mut(),
                bInheritHandle: 0,
            };
            if name.is_some() {
                let sddl = "D:P(A;;GA;;;OW)\0".encode_utf16().collect::<Vec<_>>();
                if unsafe {
                    ConvertStringSecurityDescriptorToSecurityDescriptorW(
                        sddl.as_ptr(),
                        SDDL_REVISION_1,
                        &mut descriptor,
                        std::ptr::null_mut(),
                    )
                } == 0
                {
                    return Err(io::Error::last_os_error());
                }
                security.lpSecurityDescriptor = descriptor;
            }
            let raw_job = unsafe {
                CreateJobObjectW(
                    if name.is_some() {
                        &security
                    } else {
                        std::ptr::null()
                    },
                    name.map_or(std::ptr::null(), |value| value.as_ptr()),
                )
            };
            if !descriptor.is_null() {
                unsafe { LocalFree(descriptor.cast()) };
            }
            if raw_job.is_null() {
                return Err(io::Error::last_os_error());
            }
            let job = unsafe { OwnedHandle::from_raw_handle(raw_job as RawHandle) };
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let configured = unsafe {
                SetInformationJobObject(
                    raw_job,
                    JobObjectExtendedLimitInformation,
                    (&raw const info).cast(),
                    size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                )
            };
            if configured == 0 {
                return Err(io::Error::last_os_error());
            }
            if unsafe { AssignProcessToJobObject(raw_job, process) } == 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(Self {
                job: Some(job),
                detached_process: None,
                terminate_on_drop: true,
            })
        }

        pub fn bind_tokio_child(child: &Child) -> io::Result<Self> {
            let handle = child
                .raw_handle()
                .ok_or_else(|| io::Error::other("child process handle is unavailable"))?;
            Self::bind_handle(handle as HANDLE)
        }

        pub fn bind_std_child(child: &std::process::Child) -> io::Result<Self> {
            Self::bind_handle(child.as_raw_handle() as HANDLE)
        }

        pub fn bind_raw_handle(handle: RawHandle) -> io::Result<Self> {
            Self::bind_handle(handle as HANDLE)
        }

        pub fn noop() -> Self {
            Self {
                job: None,
                detached_process: None,
                terminate_on_drop: false,
            }
        }

        pub fn track_detached_child(child: &std::process::Child) -> Self {
            Self {
                job: None,
                detached_process: Some(child.as_handle().try_clone_to_owned()),
                terminate_on_drop: false,
            }
        }

        pub fn terminate(&mut self) -> io::Result<()> {
            if let Some(job) = self.job.take() {
                if unsafe { TerminateJobObject(job.as_raw_handle() as HANDLE, TREE_EXIT_CODE) } == 0
                {
                    let err = io::Error::last_os_error();
                    if err.raw_os_error() != Some(5) {
                        self.job = Some(job);
                        return Err(err);
                    }
                }
                return Ok(());
            }
            let Some(process) = self.detached_process.as_ref() else {
                return Ok(());
            };
            let handle = match process {
                Ok(handle) => handle.try_clone()?,
                Err(error) => return Err(io::Error::new(error.kind(), error.to_string())),
            };
            let stopped = terminate_owned_process_tree(handle);
            if stopped.is_ok() {
                self.detached_process = None;
            }
            stopped
        }
    }

    impl Drop for ProcessTreeGuard {
        fn drop(&mut self) {
            if self.terminate_on_drop {
                let _ = self.terminate();
            }
        }
    }

    pub fn configure_tokio_process_tree(_command: &mut tokio::process::Command) {}

    pub fn configure_std_process_tree(_command: &mut std::process::Command) {}

    pub fn bind_current_process_lifetime() -> io::Result<()> {
        let job_name = format!("Local\\xmatrix-run-{}", uuid::Uuid::new_v4().simple());
        let mut wide = std::ffi::OsStr::new(&job_name)
            .encode_wide()
            .collect::<Vec<_>>();
        wide.push(0);
        let guard =
            ProcessTreeGuard::bind_handle_named(unsafe { GetCurrentProcess() }, Some(&wide))?;
        unsafe { std::env::set_var("XMATRIX_RUN_JOB_NAME", &job_name) };
        // The wrapper itself is a member of this kill-on-close job. Keep the
        // handle open until process teardown; the OS then closes it atomically
        // even for forced termination and kills every inherited descendant.
        std::mem::forget(guard);
        Ok(())
    }

    fn process_handle(pid: u32, access: u32) -> io::Result<OwnedHandle> {
        let handle = unsafe { OpenProcess(access, 0, pid) };
        if handle.is_null() {
            Err(io::Error::last_os_error())
        } else {
            Ok(unsafe { OwnedHandle::from_raw_handle(handle as RawHandle) })
        }
    }

    pub fn process_alive(pid: u32) -> bool {
        let Ok(handle) =
            process_handle(pid, PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE)
        else {
            return false;
        };
        unsafe { WaitForSingleObject(handle.as_raw_handle() as HANDLE, 0) == WAIT_TIMEOUT }
    }

    fn snapshot_process_parents() -> io::Result<HashMap<u32, Vec<u32>>> {
        let raw_snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
        if raw_snapshot == INVALID_HANDLE_VALUE {
            return Err(io::Error::last_os_error());
        }
        let snapshot = unsafe { OwnedHandle::from_raw_handle(raw_snapshot as RawHandle) };
        let mut entry: PROCESSENTRY32W = unsafe { std::mem::zeroed() };
        entry.dwSize = size_of::<PROCESSENTRY32W>() as u32;
        let mut parents: HashMap<u32, Vec<u32>> = HashMap::new();
        if unsafe { Process32FirstW(snapshot.as_raw_handle() as HANDLE, &mut entry) } == 0 {
            return Err(io::Error::last_os_error());
        }
        loop {
            parents
                .entry(entry.th32ParentProcessID)
                .or_default()
                .push(entry.th32ProcessID);
            if unsafe { Process32NextW(snapshot.as_raw_handle() as HANDLE, &mut entry) } == 0 {
                let error = unsafe { GetLastError() };
                if error != ERROR_NO_MORE_FILES {
                    return Err(io::Error::from_raw_os_error(error as i32));
                }
                break;
            }
        }
        Ok(parents)
    }

    fn process_times(handle: &OwnedHandle) -> io::Result<(u64, Option<u64>)> {
        // The handle identifies an object even after its PID has been recycled.
        // Sample its exit state before GetProcessTimes; live exit times are undefined.
        let exited = match unsafe { WaitForSingleObject(handle.as_raw_handle() as HANDLE, 0) } {
            WAIT_OBJECT_0 => true,
            WAIT_TIMEOUT => false,
            WAIT_FAILED => return Err(io::Error::last_os_error()),
            _ => return Err(io::Error::other("unexpected process wait result")),
        };
        let (created, exit) = process_file_times(handle)?;
        if created == 0 {
            return Err(io::Error::other("process creation time is unavailable"));
        }
        Ok((created, exited.then_some(exit)))
    }

    /// Raw OS times for an owned process handle; callers decide whether zero is meaningful.
    pub fn process_file_times(handle: &OwnedHandle) -> io::Result<(u64, u64)> {
        let mut created: FILETIME = unsafe { std::mem::zeroed() };
        let mut exit: FILETIME = unsafe { std::mem::zeroed() };
        let mut kernel: FILETIME = unsafe { std::mem::zeroed() };
        let mut user: FILETIME = unsafe { std::mem::zeroed() };
        if unsafe {
            GetProcessTimes(
                handle.as_raw_handle() as HANDLE,
                &mut created,
                &mut exit,
                &mut kernel,
                &mut user,
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        let ticks = |value: FILETIME| {
            (u64::from(value.dwHighDateTime) << 32) | u64::from(value.dwLowDateTime)
        };
        Ok((ticks(created), ticks(exit)))
    }

    fn ensure_noncritical(handle: &OwnedHandle) -> io::Result<()> {
        let mut critical = 0;
        if unsafe { IsProcessCritical(handle.as_raw_handle() as HANDLE, &mut critical) } == 0 {
            return Err(io::Error::last_os_error());
        }
        if critical != 0 {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "refusing to terminate a Windows critical process",
            ));
        }
        Ok(())
    }

    fn stop_handle(pid: u32) -> io::Result<OwnedHandle> {
        process_handle(
            pid,
            PROCESS_TERMINATE | PROCESS_SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION,
        )
    }

    /// ParentProcessId is a historical numeric value, not ownership. Open and
    /// retain each object, verify its creation falls within its parent's lifetime,
    /// and re-read its parent after opening it. Never traverse a recycled edge.
    fn owned_tree_handles(root: OwnedHandle) -> io::Result<Vec<OwnedHandle>> {
        owned_tree_handles_with_snapshot(root, snapshot_process_parents)
    }

    fn owned_tree_handles_with_snapshot(
        root: OwnedHandle,
        mut snapshot: impl FnMut() -> io::Result<HashMap<u32, Vec<u32>>>,
    ) -> io::Result<Vec<OwnedHandle>> {
        let root_pid = unsafe { GetProcessId(root.as_raw_handle() as HANDLE) };
        if root_pid == 0 {
            return Err(io::Error::last_os_error());
        }
        ensure_noncritical(&root)?;
        process_times(&root)?;
        let parents = snapshot()?;
        let mut handles = vec![root];
        let mut queue = VecDeque::from([(root_pid, 0usize)]);
        let mut seen = HashSet::from([root_pid]);
        while let Some((parent_pid, parent_index)) = queue.pop_front() {
            for child_pid in parents.get(&parent_pid).into_iter().flatten().copied() {
                if !seen.insert(child_pid) {
                    continue;
                }
                let child = match stop_handle(child_pid) {
                    Ok(child) => child,
                    // It exited before we acquired an identity. No PID-only
                    // recursion into its possible successors is permitted.
                    Err(error) if error.raw_os_error() == Some(ERROR_INVALID_PARAMETER as i32) => {
                        continue;
                    }
                    // An older process we may not terminate can still name a
                    // recycled PID of ours as its parent. Skip it only when its
                    // birth proves it is not a descendant; otherwise fail closed.
                    Err(error) if error.raw_os_error() == Some(ERROR_ACCESS_DENIED as i32) => {
                        if !birth_proves_unrelated(child_pid, &handles[parent_index]) {
                            return Err(error);
                        }
                        continue;
                    }
                    Err(error) => return Err(error),
                };
                let (child_created, _) = process_times(&child)?;
                let (parent_created, parent_exited) = process_times(&handles[parent_index])?;
                if !super::process_birth_within_parent_lifetime(
                    parent_created,
                    parent_exited,
                    child_created,
                ) {
                    continue;
                }
                let fresh = snapshot()?;
                if !fresh
                    .get(&parent_pid)
                    .is_some_and(|children| children.contains(&child_pid))
                {
                    // An opened but now-exited object may no longer appear in a
                    // snapshot. Refuse to infer lineage from the earlier PID.
                    return Err(io::Error::other("process ancestry changed during stop"));
                }
                ensure_noncritical(&child)?;
                let index = handles.len();
                handles.push(child);
                queue.push_back((child_pid, index));
            }
        }
        Ok(handles)
    }

    fn birth_proves_unrelated(child_pid: u32, parent: &OwnedHandle) -> bool {
        let Ok(child) = process_handle(
            child_pid,
            PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
        ) else {
            return false;
        };
        let (Ok((child_created, _)), Ok((parent_created, parent_exited))) =
            (process_times(&child), process_times(parent))
        else {
            return false;
        };
        !super::process_birth_within_parent_lifetime(parent_created, parent_exited, child_created)
    }

    #[cfg(test)]
    mod ownership_tests {
        use super::*;
        use std::process::{Child, Command, Stdio};

        struct Fixture(Child);

        impl Fixture {
            fn spawn() -> Self {
                Self(
                    Command::new("ping.exe")
                        .args(["-n", "60", "127.0.0.1"])
                        .stdout(Stdio::null())
                        .stderr(Stdio::null())
                        .spawn()
                        .unwrap(),
                )
            }
        }

        impl Drop for Fixture {
            fn drop(&mut self) {
                // Cleanup uses the actual Child handle, never a system snapshot.
                let _ = self.0.kill();
                let _ = self.0.wait();
            }
        }

        #[test]
        fn recycled_parent_edge_preserves_an_unrelated_owned_fixture() {
            let mut unrelated = Fixture::spawn();
            std::thread::sleep(Duration::from_millis(25));
            let mut root = Fixture::spawn();
            let parents = HashMap::from([(root.0.id(), vec![unrelated.0.id()])]);
            let handles =
                owned_tree_handles_with_snapshot(stop_handle(root.0.id()).unwrap(), || {
                    Ok(parents.clone())
                })
                .unwrap();
            assert_eq!(
                handles.len(),
                1,
                "an older process must not enter the termination set"
            );
            terminate_one(&handles[0]).unwrap();
            wait_for_process_exit(&handles[0], 3_000).unwrap();
            assert!(root.0.try_wait().unwrap().is_some());
            assert!(
                unrelated.0.try_wait().unwrap().is_none(),
                "unrelated fixture was terminated"
            );
        }

        fn older_protected_pid() -> u32 {
            let raw = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
            assert_ne!(raw, INVALID_HANDLE_VALUE);
            let snapshot = unsafe { OwnedHandle::from_raw_handle(raw as RawHandle) };
            let mut entry: PROCESSENTRY32W = unsafe { std::mem::zeroed() };
            entry.dwSize = size_of::<PROCESSENTRY32W>() as u32;
            let mut more =
                unsafe { Process32FirstW(snapshot.as_raw_handle() as HANDLE, &mut entry) } != 0;
            while more {
                let len = entry.szExeFile.iter().position(|&c| c == 0).unwrap_or(0);
                let name = String::from_utf16_lossy(&entry.szExeFile[..len]);
                if name.eq_ignore_ascii_case("csrss.exe") {
                    return entry.th32ProcessID;
                }
                more =
                    unsafe { Process32NextW(snapshot.as_raw_handle() as HANDLE, &mut entry) } != 0;
            }
            panic!("csrss.exe is always running on Windows");
        }

        #[test]
        fn recycled_parent_edge_to_an_unterminable_older_process_is_skipped() {
            let protected = older_protected_pid();
            let root = Fixture::spawn();
            let parents = HashMap::from([(root.0.id(), vec![protected])]);
            let handles =
                owned_tree_handles_with_snapshot(stop_handle(root.0.id()).unwrap(), || {
                    Ok(parents.clone())
                })
                .expect("an older process we may not open cannot block cleanup");
            assert_eq!(handles.len(), 1);
        }

        #[test]
        fn changed_parent_after_opening_a_pid_aborts_without_termination() {
            let mut root = Fixture::spawn();
            std::thread::sleep(Duration::from_millis(25));
            let mut unrelated = Fixture::spawn();
            let mut reads = 0;
            let result =
                owned_tree_handles_with_snapshot(stop_handle(root.0.id()).unwrap(), || {
                    reads += 1;
                    Ok(if reads == 1 {
                        HashMap::from([(root.0.id(), vec![unrelated.0.id()])])
                    } else {
                        HashMap::new()
                    })
                });
            assert!(
                result.is_err(),
                "a stale parent snapshot cannot authorize a stop"
            );
            assert!(root.0.try_wait().unwrap().is_none());
            assert!(unrelated.0.try_wait().unwrap().is_none());
        }

        #[test]
        fn exited_process_with_still_active_exit_code_is_not_alive() {
            let mut child = Command::new("cmd.exe")
                .args(["/C", "exit 259"])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .unwrap();
            assert_eq!(child.wait().unwrap().code(), Some(259));
            assert!(!process_alive(child.id()));
        }

        #[test]
        fn dead_wrapper_pid_is_an_empty_tree() {
            let mut child = Command::new("cmd.exe")
                .args(["/C", "exit 0"])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .unwrap();
            let pid = child.id();
            assert_eq!(child.wait().unwrap().code(), Some(0));
            terminate_process_tree(pid).expect("gone wrapper cannot authorize another tree");
        }

        #[test]
        fn invalid_parameter_means_the_termination_target_is_gone() {
            let err = io::Error::from_raw_os_error(ERROR_INVALID_PARAMETER as i32);
            assert!(termination_target_is_gone(&err));
            assert!(!termination_target_is_gone(&io::Error::from(
                io::ErrorKind::PermissionDenied
            )));
        }

        #[test]
        fn critical_or_unreadable_classification_never_reaches_termination() {
            for kind in [io::ErrorKind::PermissionDenied, io::ErrorKind::Other] {
                let mut child = Fixture::spawn();
                let handle = stop_handle(child.0.id()).unwrap();
                let outcome = terminate_one_checked(&handle, |_| Err(io::Error::from(kind)));
                assert_eq!(outcome.unwrap_err().kind(), kind);
                assert!(child.0.try_wait().unwrap().is_none());
            }
        }
    }

    fn wait_for_process_exit(handle: &OwnedHandle, timeout_ms: u32) -> io::Result<()> {
        match unsafe { WaitForSingleObject(handle.as_raw_handle() as HANDLE, timeout_ms) } {
            WAIT_OBJECT_0 => Ok(()),
            WAIT_TIMEOUT => Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "process handle is not signaled after termination",
            )),
            WAIT_FAILED => Err(io::Error::last_os_error()),
            _ => Err(io::Error::other("unexpected process wait result")),
        }
    }

    #[test]
    fn process_exit_wait_distinguishes_live_and_signaled_owned_handles() {
        let mut child = std::process::Command::new("ping.exe")
            .args(["-n", "60", "127.0.0.1"])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .expect("spawn owned wait fixture");
        let handle = process_handle(child.id(), PROCESS_SYNCHRONIZE).unwrap();
        let pending = wait_for_process_exit(&handle, 0);
        let _ = child.kill();
        let _ = child.wait();
        assert_eq!(pending.unwrap_err().kind(), io::ErrorKind::TimedOut);
        wait_for_process_exit(&handle, 0).expect("reaped process handle is signaled");
    }

    fn terminate_one(handle: &OwnedHandle) -> io::Result<()> {
        terminate_one_checked(handle, ensure_noncritical)
    }

    fn terminate_one_checked(
        handle: &OwnedHandle,
        check: impl FnOnce(&OwnedHandle) -> io::Result<()>,
    ) -> io::Result<()> {
        match wait_for_process_exit(handle, 0) {
            Ok(()) => return Ok(()),
            Err(error) if error.kind() == io::ErrorKind::TimedOut => {}
            Err(error) => return Err(error),
        }
        // This check uses the same object handle passed to TerminateProcess.
        // Failed classification must never turn into permission to terminate.
        check(handle)?;
        if unsafe { TerminateProcess(handle.as_raw_handle() as HANDLE, TREE_EXIT_CODE) } == 0 {
            let error = io::Error::last_os_error();
            wait_for_process_exit(handle, 0).map_err(|_| error)?;
        }
        Ok(())
    }

    pub fn termination_target_is_gone(err: &io::Error) -> bool {
        matches!(
            err.raw_os_error(),
            Some(code)
                if code == ERROR_INVALID_PARAMETER as i32 || code == ERROR_INVALID_HANDLE as i32
        )
    }

    /// Ends exactly one process. A wrapper is a member of its own
    /// kill-on-close Job, so ending it takes its provider and every other
    /// descendant with it — the Windows counterpart of a wrapper's own
    /// teardown on Unix.
    pub fn terminate_single_process(pid: u32) -> io::Result<()> {
        match stop_handle(pid) {
            Ok(handle) => terminate_one(&handle),
            Err(err) if termination_target_is_gone(&err) => Ok(()),
            Err(err) => Err(err),
        }
    }

    pub fn terminate_process_tree(pid: u32) -> io::Result<()> {
        // Capture the root before reading descendants. If it is unavailable,
        // its historical numeric PID cannot authorize killing another tree.
        match stop_handle(pid) {
            Ok(root) => terminate_owned_process_tree(root),
            // The wrapper already exited. OpenProcess then fails with
            // ERROR_INVALID_PARAMETER; treating that as success lets the daemon
            // drop the registry slot instead of retrying the same dead PID.
            Err(err) if termination_target_is_gone(&err) => Ok(()),
            Err(err) => Err(err),
        }
    }

    fn terminate_owned_process_tree(root: OwnedHandle) -> io::Result<()> {
        let mut handles = owned_tree_handles(root)?;
        handles.reverse();
        let mut first_error = None;
        for handle in &handles {
            if let Err(error) = terminate_one(handle) {
                first_error.get_or_insert(error);
            }
        }

        // TerminateProcess is asynchronous. Retain the original handles until
        // they signal; GetExitCodeProcess/PID lookup is not an exit barrier.
        // Every target shares one bounded wait, not three seconds per process.
        let deadline = Instant::now() + TERMINATION_WAIT;
        for handle in handles {
            let remaining_ms = deadline
                .saturating_duration_since(Instant::now())
                .as_millis()
                .min(u32::MAX as u128) as u32;
            if let Err(err) = wait_for_process_exit(&handle, remaining_ms) {
                first_error.get_or_insert(err);
            }
        }
        match first_error {
            Some(error) => Err(error),
            None => Ok(()),
        }
    }
}

#[cfg(unix)]
mod platform {
    use std::collections::{HashMap, HashSet, VecDeque};
    use std::io;
    use std::os::unix::process::CommandExt;
    use std::time::{Duration, Instant};

    use tokio::process::Child;

    const TERMINATION_WAIT: Duration = Duration::from_secs(3);

    #[derive(Debug)]
    pub struct ProcessTreeGuard {
        process_group: Option<libc::pid_t>,
        terminate_on_drop: bool,
    }

    impl ProcessTreeGuard {
        pub fn bind_tokio_child(child: &Child) -> io::Result<Self> {
            let pid = child
                .id()
                .ok_or_else(|| io::Error::other("child process id is unavailable"))?;
            Ok(Self {
                process_group: Some(pid as libc::pid_t),
                terminate_on_drop: true,
            })
        }

        pub fn bind_std_child(child: &std::process::Child) -> io::Result<Self> {
            Ok(Self {
                process_group: Some(child.id() as libc::pid_t),
                terminate_on_drop: true,
            })
        }

        pub fn bind_process_id(pid: u32) -> Self {
            Self {
                process_group: Some(pid as libc::pid_t),
                terminate_on_drop: true,
            }
        }

        pub fn noop() -> Self {
            Self {
                process_group: None,
                terminate_on_drop: false,
            }
        }

        pub fn track_detached_child(child: &std::process::Child) -> Self {
            Self {
                process_group: Some(child.id() as libc::pid_t),
                terminate_on_drop: false,
            }
        }

        pub fn terminate(&mut self) -> io::Result<()> {
            let Some(process_group) = self.process_group.take() else {
                return Ok(());
            };
            // The daemon starts each Agent wrapper as a session leader, while
            // provider adapters place their own children in separate process
            // groups. Killing only the wrapper's group can therefore leave a
            // Codex app-server (and its thread-writer lock) alive after Reborn.
            // The bounded tree terminator follows descendants and, for a
            // session leader, every process group that remains in its session.
            if let Err(err) = terminate_process_tree(process_group as u32) {
                self.process_group = Some(process_group);
                Err(err)
            } else {
                Ok(())
            }
        }
    }

    impl Drop for ProcessTreeGuard {
        fn drop(&mut self) {
            if self.terminate_on_drop {
                let _ = self.terminate();
            }
        }
    }

    pub fn configure_tokio_process_tree(command: &mut tokio::process::Command) {
        command.process_group(0);
    }

    pub fn configure_std_process_tree(command: &mut std::process::Command) {
        command.process_group(0);
    }

    pub fn bind_current_process_lifetime() -> io::Result<()> {
        Ok(())
    }

    pub fn process_alive(pid: u32) -> bool {
        let result = unsafe { libc::kill(pid as libc::pid_t, 0) };
        result == 0 || io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
    }

    #[derive(Clone, Copy)]
    struct ProcessRecord {
        pid: u32,
        parent_pid: u32,
        process_group: libc::pid_t,
        session: libc::pid_t,
    }

    fn process_records() -> io::Result<Vec<ProcessRecord>> {
        let output = std::process::Command::new("ps")
            .args([
                "-e", "-o", "pid=", "-o", "ppid=", "-o", "pgid=", "-o", "stat=",
            ])
            .output()?;
        if !output.status.success() {
            return Err(io::Error::other(format!(
                "ps process-tree snapshot exited with {}",
                output.status
            )));
        }
        Ok(String::from_utf8_lossy(&output.stdout)
            .lines()
            .filter_map(|line| {
                let mut fields = line.split_whitespace();
                let pid = fields.next()?.parse::<u32>().ok()?;
                let parent_pid = fields.next()?.parse::<u32>().ok()?;
                let process_group = fields.next()?.parse::<libc::pid_t>().ok()?;
                let state = fields.next().unwrap_or_default();
                if state.starts_with('Z') {
                    return None;
                }
                let session = unsafe { libc::getsid(pid as libc::pid_t) };
                (session >= 0).then_some(ProcessRecord {
                    pid,
                    parent_pid,
                    process_group,
                    session,
                })
            })
            .collect())
    }

    fn process_tree_records(root: u32, records: &[ProcessRecord]) -> Vec<ProcessRecord> {
        let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
        let by_pid = records
            .iter()
            .map(|record| {
                children
                    .entry(record.parent_pid)
                    .or_default()
                    .push(record.pid);
                (record.pid, *record)
            })
            .collect::<HashMap<_, _>>();
        let mut queue = VecDeque::from([root]);
        let mut target_pids = HashSet::from([root]);
        while let Some(parent) = queue.pop_front() {
            for child in children.get(&parent).into_iter().flatten() {
                if target_pids.insert(*child) {
                    queue.push_back(*child);
                }
            }
        }

        // Daemon-managed wrappers are session leaders. Session membership
        // survives the leader's exit, so it is the recovery key when a fatal
        // wrapper exit has already reparented its descendants.
        for record in records {
            if record.session == root as libc::pid_t || record.process_group == root as libc::pid_t
            {
                target_pids.insert(record.pid);
            }
        }
        target_pids
            .into_iter()
            .filter_map(|pid| by_pid.get(&pid).copied())
            .collect()
    }

    fn kill_target(target: libc::pid_t) -> io::Result<()> {
        let result = unsafe { libc::kill(target, libc::SIGKILL) };
        if result == 0 || io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH) {
            Ok(())
        } else {
            Err(io::Error::last_os_error())
        }
    }

    pub fn termination_target_is_gone(err: &io::Error) -> bool {
        err.raw_os_error() == Some(libc::ESRCH)
    }

    pub fn terminate_process_tree(pid: u32) -> io::Result<()> {
        let deadline = Instant::now() + TERMINATION_WAIT;
        let mut first_error = None;
        loop {
            let records = process_records()?;
            let mut targets = process_tree_records(pid, &records);
            if targets.is_empty() {
                return Ok(());
            }

            let own_group = unsafe { libc::getpgrp() };
            let mut groups = targets
                .iter()
                .map(|target| target.process_group)
                .filter(|group| *group > 0 && *group != own_group)
                .collect::<Vec<_>>();
            groups.sort_unstable();
            groups.dedup();
            for group in groups {
                if let Err(err) = kill_target(-group) {
                    first_error.get_or_insert(err);
                }
            }

            targets.sort_unstable_by_key(|target| std::cmp::Reverse(target.pid));
            for target in targets {
                if target.pid == std::process::id() {
                    continue;
                }
                if let Err(err) = kill_target(target.pid as libc::pid_t) {
                    first_error.get_or_insert(err);
                }
            }

            if Instant::now() >= deadline {
                let records = process_records()?;
                let survivors = process_tree_records(pid, &records)
                    .into_iter()
                    .map(|record| record.pid)
                    .collect::<Vec<_>>();
                if survivors.is_empty() {
                    return Ok(());
                }
                return Err(first_error.unwrap_or_else(|| {
                    io::Error::other(format!(
                        "process tree still alive after termination: {survivors:?}"
                    ))
                }));
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    }
}

#[cfg(not(any(unix, windows)))]
mod platform {
    use std::io;

    use tokio::process::Child;

    #[derive(Debug, Default)]
    pub struct ProcessTreeGuard;

    impl ProcessTreeGuard {
        pub fn bind_tokio_child(_child: &Child) -> io::Result<Self> {
            Ok(Self)
        }

        pub fn bind_std_child(_child: &std::process::Child) -> io::Result<Self> {
            Ok(Self)
        }

        pub fn noop() -> Self {
            Self
        }

        pub fn track_detached_child(_child: &std::process::Child) -> Self {
            Self
        }

        pub fn terminate(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    impl Drop for ProcessTreeGuard {
        fn drop(&mut self) {
            let _ = self.terminate();
        }
    }

    pub fn configure_tokio_process_tree(_command: &mut tokio::process::Command) {}

    pub fn configure_std_process_tree(_command: &mut std::process::Command) {}

    pub fn bind_current_process_lifetime() -> io::Result<()> {
        Ok(())
    }

    pub fn process_alive(_pid: u32) -> bool {
        false
    }

    pub fn termination_target_is_gone(_err: &io::Error) -> bool {
        false
    }

    pub fn terminate_process_tree(pid: u32) -> io::Result<()> {
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            format!("process-tree termination is unsupported for pid {pid}"),
        ))
    }
}

pub use platform::{
    ProcessTreeGuard, bind_current_process_lifetime, configure_std_process_tree,
    configure_tokio_process_tree, process_alive, terminate_process_tree,
    termination_target_is_gone,
};
#[cfg(windows)]
pub use platform::{process_file_times, terminate_single_process};

/// Windows `CREATE_NO_WINDOW`: a background child gets no console window.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Keeps a background child from opening a console window on Windows.
pub fn hide_console_window(command: &mut std::process::Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt as _;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(not(windows))]
    let _ = command;
}

/// [`hide_console_window`] for a Tokio command.
pub fn hide_tokio_console_window(command: &mut tokio::process::Command) {
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);
    #[cfg(not(windows))]
    let _ = command;
}

/// Sends SIGTERM to exactly one process, leaving its descendants alone. Used
/// by `update-self`, which runs inside the target wrapper's own process tree:
/// the wrapper must be asked to shut down gracefully (its own teardown handles
/// the tree) rather than having the tree the caller occupies killed under it.
#[cfg(unix)]
pub fn terminate_single_process(pid: u32) -> io::Result<()> {
    let result = unsafe { libc::kill(pid as libc::pid_t, libc::SIGTERM) };
    if result == 0 || io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH) {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

pub fn guard_tokio_child(child: &mut tokio::process::Child) -> io::Result<ProcessTreeGuard> {
    match ProcessTreeGuard::bind_tokio_child(child) {
        Ok(guard) => Ok(guard),
        Err(err) => {
            if child.try_wait()?.is_some() {
                return Ok(ProcessTreeGuard::noop());
            }
            if let Some(pid) = child.id() {
                let _ = terminate_process_tree(pid);
            }
            let _ = child.start_kill();
            Err(err)
        }
    }
}

pub fn guard_std_child(child: &mut std::process::Child) -> io::Result<ProcessTreeGuard> {
    match ProcessTreeGuard::bind_std_child(child) {
        Ok(guard) => Ok(guard),
        Err(err) => {
            if child.try_wait()?.is_some() {
                return Ok(ProcessTreeGuard::noop());
            }
            let _ = terminate_process_tree(child.id());
            let _ = child.kill();
            Err(err)
        }
    }
}

/// Tracks a daemon-managed wrapper without tying its lifetime to the daemon
/// process. The wrapper owns its own descendant guard; this handle exists only
/// so explicit stop/reborn can still terminate the complete tree. Dropping it
/// during daemon replacement deliberately leaves the wrapper running for the
/// next daemon generation to rehydrate by PID.
pub fn track_detached_std_child(child: &std::process::Child) -> ProcessTreeGuard {
    ProcessTreeGuard::track_detached_child(child)
}

#[cfg(windows)]
pub fn bind_portable_pty_child(child: &dyn portable_pty::Child) -> io::Result<ProcessTreeGuard> {
    let handle = child
        .as_raw_handle()
        .ok_or_else(|| io::Error::other("PTY child process handle is unavailable"))?;
    ProcessTreeGuard::bind_raw_handle(handle)
}

#[cfg(unix)]
pub fn bind_portable_pty_child(child: &dyn portable_pty::Child) -> io::Result<ProcessTreeGuard> {
    let pid = child
        .process_id()
        .ok_or_else(|| io::Error::other("PTY child process id is unavailable"))?;
    Ok(ProcessTreeGuard::bind_process_id(pid))
}

#[cfg(not(any(unix, windows)))]
pub fn bind_portable_pty_child(_child: &dyn portable_pty::Child) -> io::Result<ProcessTreeGuard> {
    Ok(ProcessTreeGuard::noop())
}

pub fn guard_portable_pty_child(
    child: &mut dyn portable_pty::Child,
) -> io::Result<ProcessTreeGuard> {
    match bind_portable_pty_child(child) {
        Ok(guard) => Ok(guard),
        Err(err) => {
            if let Some(pid) = child.process_id() {
                let _ = terminate_process_tree(pid);
            }
            let _ = child.kill();
            Err(err)
        }
    }
}

#[cfg(test)]
mod test_support {
    use std::path::{Path, PathBuf};
    use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

    use super::process_alive;

    pub(super) fn temp_pid_file(label: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time")
            .as_nanos();
        std::env::temp_dir().join(format!(
            "xmatrix-process-tree-{label}-{}-{nonce}.pid",
            std::process::id()
        ))
    }

    pub(super) fn read_descendant_pid(pid_file: &Path) -> u32 {
        // A cold PowerShell startup on a shared Windows runner can exceed
        // five seconds. Give fixture readiness its own bounded budget;
        // assert_process_exits still checks termination within five seconds.
        let startup_wait = Duration::from_secs(if cfg!(windows) { 30 } else { 5 });
        let deadline = Instant::now() + startup_wait;
        loop {
            if let Ok(text) = std::fs::read_to_string(pid_file)
                && let Ok(pid) = text.trim().parse::<u32>()
            {
                return pid;
            }
            assert!(
                Instant::now() < deadline,
                "descendant pid file {} was not written within {startup_wait:?}",
                pid_file.display()
            );
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    pub(super) fn configure_fixture_command(command: &mut std::process::Command, pid_file: &Path) {
        command
            .env("XMATRIX_TEST_CHILD_PID_FILE", pid_file)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null());
    }

    pub(super) fn reap_descendant(
        parent: &mut std::process::Child,
        descendant: u32,
        pid_file: &Path,
    ) {
        let _ = parent.wait();
        assert_process_exits(descendant);
        let _ = std::fs::remove_file(pid_file);
    }

    pub(super) fn detached_tracker_preserves_tree(
        slug: &str,
        spawn: impl FnOnce(&Path) -> std::process::Child,
    ) {
        let pid_file = temp_pid_file(slug);
        let mut parent = spawn(&pid_file);
        let parent_pid = parent.id();
        let descendant = read_descendant_pid(&pid_file);
        let guard = super::track_detached_std_child(&parent);
        drop(guard);
        assert!(super::process_alive(parent_pid));
        assert!(super::process_alive(descendant));
        super::terminate_process_tree(parent_pid).expect("clean up detached process tree");
        reap_descendant(&mut parent, descendant, &pid_file);
    }

    pub(super) fn assert_process_exits(pid: u32) {
        let deadline = Instant::now() + Duration::from_secs(5);
        while process_alive(pid) && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(!process_alive(pid), "process {pid} remained alive");
    }
}

#[cfg(all(test, windows))]
mod tests {
    use std::path::Path;
    use std::process::{Child, Command, Stdio};

    use super::test_support::{
        assert_process_exits, configure_fixture_command, detached_tracker_preserves_tree,
        read_descendant_pid, reap_descendant, temp_pid_file,
    };
    use super::{
        bind_current_process_lifetime, guard_std_child, process_alive, terminate_process_tree,
        track_detached_std_child,
    };

    fn spawn_parent_with_descendant(pid_file: &Path) -> Child {
        let script = concat!(
            "$child = Start-Process -FilePath $env:ComSpec ",
            "-ArgumentList '/d','/c','ping -n 60 127.0.0.1 > nul' ",
            "-WindowStyle Hidden -PassThru; ",
            "[IO.File]::WriteAllText($env:XMATRIX_TEST_CHILD_PID_FILE, [string]$child.Id); ",
            "Wait-Process -Id $child.Id"
        );
        let mut command = Command::new("powershell");
        command.args(["-NoProfile", "-Command", script]);
        configure_fixture_command(&mut command, pid_file);
        super::configure_std_process_tree(&mut command);
        command.spawn().expect("spawn process-tree test parent")
    }

    #[test]
    fn job_guard_terminates_descendants() {
        bind_current_process_lifetime().expect("bind wrapper lifetime job");
        let pid_file = temp_pid_file("job");
        let mut parent = spawn_parent_with_descendant(&pid_file);
        let mut guard = guard_std_child(&mut parent).expect("bind parent to job");
        let descendant = read_descendant_pid(&pid_file);
        assert!(process_alive(descendant));

        guard.terminate().expect("terminate job");
        reap_descendant(&mut parent, descendant, &pid_file);
    }

    #[test]
    fn dropping_job_guard_terminates_descendants() {
        bind_current_process_lifetime().expect("bind wrapper lifetime job");
        let pid_file = temp_pid_file("job-drop");
        let mut parent = spawn_parent_with_descendant(&pid_file);
        let guard = guard_std_child(&mut parent).expect("bind parent to job");
        let descendant = read_descendant_pid(&pid_file);
        assert!(process_alive(descendant));

        drop(guard);
        reap_descendant(&mut parent, descendant, &pid_file);
    }

    #[test]
    fn hard_stop_waits_for_the_owned_process_handle_before_returning() {
        for _ in 0..16 {
            let mut child = Command::new("ping.exe")
                .args(["-n", "60", "127.0.0.1"])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .expect("spawn owned stop fixture");
            let outcome = terminate_process_tree(child.id());
            let exited = child
                .try_wait()
                .expect("observe owned process handle")
                .is_some();
            let _ = child.kill();
            let _ = child.wait();
            assert!(outcome.is_ok(), "stop failed: {outcome:?}");
            assert!(exited, "stop returned before the process handle signaled");
        }
    }

    #[test]
    fn hard_stop_terminates_unmanaged_descendants() {
        let pid_file = temp_pid_file("hard-stop");
        let mut parent = spawn_parent_with_descendant(&pid_file);
        let descendant = read_descendant_pid(&pid_file);
        assert!(process_alive(descendant));

        terminate_process_tree(parent.id()).expect("terminate unmanaged process tree");
        reap_descendant(&mut parent, descendant, &pid_file);
    }

    #[test]
    fn dropping_detached_tracker_preserves_process_tree() {
        detached_tracker_preserves_tree("detached-drop", spawn_parent_with_descendant);
    }

    #[test]
    fn detached_tracker_explicitly_terminates_process_tree() {
        let pid_file = temp_pid_file("detached-stop");
        let mut parent = spawn_parent_with_descendant(&pid_file);
        let descendant = read_descendant_pid(&pid_file);
        assert!(process_alive(descendant));
        let mut guard = track_detached_std_child(&parent);

        guard.terminate().expect("terminate detached process tree");
        assert_process_exits(descendant);
        let _ = parent.wait();
        let _ = std::fs::remove_file(pid_file);
    }

    #[test]
    fn exited_root_still_identifies_and_terminates_descendants() {
        let pid_file = temp_pid_file("exited-root");
        let mut parent = spawn_parent_with_descendant(&pid_file);
        let parent_pid = parent.id();
        let descendant = read_descendant_pid(&pid_file);
        assert!(process_alive(descendant));

        parent.kill().expect("kill process-tree root only");
        let _ = parent.wait();
        assert!(process_alive(descendant));

        terminate_process_tree(parent_pid).expect("terminate descendants of exited root");
        assert_process_exits(descendant);
        let _ = std::fs::remove_file(pid_file);
    }
}

#[cfg(all(test, unix))]
mod unix_tests {
    use std::os::unix::process::CommandExt;
    use std::path::Path;
    use std::process::{Child, Command, Stdio};

    use super::test_support::{
        assert_process_exits, configure_fixture_command, detached_tracker_preserves_tree,
        read_descendant_pid, reap_descendant, temp_pid_file,
    };
    use super::{guard_std_child, process_alive, terminate_process_tree, track_detached_std_child};

    fn descendant_script() -> &'static str {
        "sleep 30 </dev/null >/dev/null 2>&1 & echo $! > \"$XMATRIX_TEST_CHILD_PID_FILE\"; wait"
    }

    fn spawn_group_with_descendant(pid_file: &Path) -> Child {
        let mut command = Command::new("sh");
        command.args(["-c", descendant_script()]);
        configure_fixture_command(&mut command, pid_file);
        super::configure_std_process_tree(&mut command);
        command.spawn().expect("spawn process-group test parent")
    }

    fn configure_fixture_session(command: &mut Command) {
        unsafe {
            command.pre_exec(|| {
                if libc::setsid() == -1 {
                    Err(std::io::Error::last_os_error())
                } else {
                    Ok(())
                }
            });
        }
    }

    fn spawn_session_with_descendant(pid_file: &Path) -> Child {
        let mut command = Command::new("sh");
        command.args(["-c", descendant_script()]);
        configure_fixture_command(&mut command, pid_file);
        configure_fixture_session(&mut command);
        command.spawn().expect("spawn process-session test parent")
    }

    fn spawn_session_with_separate_group_descendant(pid_file: &Path) -> Child {
        let mut command = Command::new(std::env::current_exe().expect("resolve test executable"));
        command
            .args([
                "--exact",
                "unix_tests::separate_group_wrapper_helper",
                "--ignored",
            ])
            .env("XMATRIX_TEST_SEPARATE_GROUP_HELPER", "1");
        configure_fixture_command(&mut command, pid_file);
        configure_fixture_session(&mut command);
        command
            .spawn()
            .expect("spawn separate-process-group session parent")
    }

    #[test]
    #[ignore = "subprocess helper for the separate process-group regression"]
    fn separate_group_wrapper_helper() {
        if std::env::var("XMATRIX_TEST_SEPARATE_GROUP_HELPER").as_deref() != Ok("1") {
            return;
        }
        let pid_file = std::env::var_os("XMATRIX_TEST_CHILD_PID_FILE")
            .expect("separate-group helper pid-file path");
        let mut command = Command::new("sleep");
        command
            .arg("30")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        super::configure_std_process_tree(&mut command);
        let mut child = command.spawn().expect("spawn separate process-group child");
        std::fs::write(pid_file, child.id().to_string()).expect("write separate-group child pid");
        let _ = child.wait();
    }

    #[test]
    fn dropping_group_guard_terminates_descendants() {
        let pid_file = temp_pid_file("unix-drop");
        let mut parent = spawn_group_with_descendant(&pid_file);
        let guard = guard_std_child(&mut parent).expect("bind parent process group");
        let descendant = read_descendant_pid(&pid_file);
        assert!(process_alive(descendant));

        drop(guard);
        reap_descendant(&mut parent, descendant, &pid_file);
    }

    #[test]
    fn dropping_detached_tracker_preserves_process_tree() {
        detached_tracker_preserves_tree("unix-detached-drop", spawn_session_with_descendant);
    }

    #[test]
    fn detached_tracker_explicitly_terminates_process_tree() {
        let pid_file = temp_pid_file("unix-detached-stop");
        let mut parent = spawn_session_with_descendant(&pid_file);
        let descendant = read_descendant_pid(&pid_file);
        let mut guard = track_detached_std_child(&parent);

        guard.terminate().expect("terminate detached process tree");
        reap_descendant(&mut parent, descendant, &pid_file);
    }

    #[test]
    fn exited_session_leader_still_identifies_and_terminates_descendants() {
        let pid_file = temp_pid_file("unix-exited-session");
        let mut parent = spawn_session_with_descendant(&pid_file);
        let parent_pid = parent.id();
        let descendant = read_descendant_pid(&pid_file);
        assert!(process_alive(descendant));

        let result = unsafe { libc::kill(parent_pid as libc::pid_t, libc::SIGKILL) };
        assert_eq!(result, 0, "kill process-session leader only");
        let _ = parent.wait();
        assert!(process_alive(descendant));

        terminate_process_tree(parent_pid).expect("terminate exited wrapper session");
        assert_process_exits(descendant);
        let _ = std::fs::remove_file(pid_file);
    }

    #[test]
    fn session_guard_terminates_separate_descendant_process_groups() {
        let pid_file = temp_pid_file("unix-session-separate-group");
        let mut parent = spawn_session_with_separate_group_descendant(&pid_file);
        let mut guard = guard_std_child(&mut parent).expect("bind wrapper session leader");
        let descendant = read_descendant_pid(&pid_file);
        assert!(process_alive(descendant));
        let parent_group = unsafe { libc::getpgid(parent.id() as libc::pid_t) };
        let descendant_group = unsafe { libc::getpgid(descendant as libc::pid_t) };
        assert!(parent_group > 0 && descendant_group > 0);
        assert_ne!(parent_group, descendant_group);

        guard
            .terminate()
            .expect("terminate complete wrapper session tree");
        reap_descendant(&mut parent, descendant, &pid_file);
    }
}
