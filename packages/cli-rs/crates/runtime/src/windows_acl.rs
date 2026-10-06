//! Owner-only Windows ACL support for daemon-owned private files.
//!
//! The caller creates the filesystem object first, then this module replaces
//! its owner and inherited DACL with the current token user and one protected
//! ACE granting that user full access. The read-back verification is intentional: a successful ACL
//! mutation that is later rewritten by policy must fail the storage open
//! instead of silently weakening the local privacy boundary.

#![cfg(windows)]

use std::ffi::c_void;
use std::io;
use std::os::windows::ffi::OsStrExt as _;
use std::path::Path;
use std::ptr;

use windows_sys::Win32::Foundation::{
    CloseHandle, ERROR_INSUFFICIENT_BUFFER, ERROR_SUCCESS, HANDLE, LocalFree,
};
use windows_sys::Win32::Security::Authorization::{
    EXPLICIT_ACCESS_W, NO_MULTIPLE_TRUSTEE, SE_FILE_OBJECT, SET_ACCESS, SetEntriesInAclW,
    SetNamedSecurityInfoW, TRUSTEE_IS_SID, TRUSTEE_IS_USER, TRUSTEE_W,
};
use windows_sys::Win32::Security::{
    ACCESS_ALLOWED_ACE, ACL, ACL_SIZE_INFORMATION, AclSizeInformation, DACL_SECURITY_INFORMATION,
    EqualSid, GetAce, GetAclInformation, GetLengthSid, GetSecurityDescriptorControl,
    GetTokenInformation, INHERITED_ACE, IsValidSid, NO_INHERITANCE, OWNER_SECURITY_INFORMATION,
    PROTECTED_DACL_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR, PSID, SE_DACL_PROTECTED,
    SUB_CONTAINERS_AND_OBJECTS_INHERIT, TOKEN_QUERY, TOKEN_USER, TokenUser,
};
use windows_sys::Win32::Storage::FileSystem::{
    FILE_ALL_ACCESS, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH, MoveFileExW,
};
use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

const ACCESS_ALLOWED_ACE_TYPE: u8 = 0;

pub fn apply_and_verify_owner_only(path: &Path, directory: bool) -> io::Result<()> {
    let wide_path = nul_terminated_path(path)?;
    let token_user = CurrentTokenUser::load()?;
    let inheritance = if directory {
        SUB_CONTAINERS_AND_OBJECTS_INHERIT
    } else {
        NO_INHERITANCE
    };
    let mut trustee = TRUSTEE_W::default();
    trustee.pMultipleTrustee = ptr::null_mut();
    trustee.MultipleTrusteeOperation = NO_MULTIPLE_TRUSTEE;
    trustee.TrusteeForm = TRUSTEE_IS_SID;
    trustee.TrusteeType = TRUSTEE_IS_USER;
    trustee.ptstrName = token_user.sid().cast();
    let explicit = EXPLICIT_ACCESS_W {
        grfAccessPermissions: FILE_ALL_ACCESS,
        grfAccessMode: SET_ACCESS,
        grfInheritance: inheritance,
        Trustee: trustee,
    };
    let mut acl: *mut ACL = ptr::null_mut();
    // SAFETY: `explicit` and `acl` are valid for this call. The returned ACL is
    // allocated by LocalAlloc and is released by `LocalAllocation` below.
    let status = unsafe { SetEntriesInAclW(1, &explicit, ptr::null(), &mut acl) };
    if status != ERROR_SUCCESS {
        return Err(win32_status("SetEntriesInAclW", status));
    }
    if acl.is_null() {
        return Err(io::Error::other("SetEntriesInAclW returned a null ACL"));
    }
    let acl_allocation = LocalAllocation(acl.cast());
    // SAFETY: the path is NUL-terminated and the ACL remains live through the
    // call. The explicit owner avoids the elevated-token default-owner case
    // (where Windows may otherwise choose the Administrators SID). Group and
    // SACL pointers remain null because neither is being changed.
    let status = unsafe {
        SetNamedSecurityInfoW(
            wide_path.as_ptr(),
            SE_FILE_OBJECT,
            OWNER_SECURITY_INFORMATION
                | DACL_SECURITY_INFORMATION
                | PROTECTED_DACL_SECURITY_INFORMATION,
            token_user.sid(),
            ptr::null_mut(),
            acl,
            ptr::null(),
        )
    };
    drop(acl_allocation);
    if status != ERROR_SUCCESS {
        return Err(win32_status("SetNamedSecurityInfoW", status));
    }
    verify_owner_only(path, directory)
}

pub fn verify_owner_only(path: &Path, directory: bool) -> io::Result<()> {
    let wide_path = nul_terminated_path(path)?;
    let token_user = CurrentTokenUser::load()?;
    let mut owner: PSID = ptr::null_mut();
    let mut dacl: *mut ACL = ptr::null_mut();
    let mut descriptor: PSECURITY_DESCRIPTOR = ptr::null_mut();
    // SAFETY: output pointers are valid, and all returned pointers remain owned
    // by `descriptor` until its LocalFree guard is dropped.
    let status = unsafe {
        windows_sys::Win32::Security::Authorization::GetNamedSecurityInfoW(
            wide_path.as_ptr(),
            SE_FILE_OBJECT,
            OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
            &mut owner,
            ptr::null_mut(),
            &mut dacl,
            ptr::null_mut(),
            &mut descriptor,
        )
    };
    if status != ERROR_SUCCESS {
        return Err(win32_status("GetNamedSecurityInfoW", status));
    }
    if descriptor.is_null() {
        return Err(io::Error::other(
            "GetNamedSecurityInfoW returned a null security descriptor",
        ));
    }
    let _descriptor_allocation = LocalAllocation(descriptor);
    if owner.is_null() || dacl.is_null() || unsafe { IsValidSid(owner) } == 0 {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "Relay V2 storage has no owner or DACL",
        ));
    }
    // SAFETY: both SIDs belong to live buffers and were validated by the
    // security APIs that produced them.
    if unsafe { EqualSid(owner, token_user.sid()) } == 0 {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "Relay V2 storage is not owned by the current user",
        ));
    }
    let mut control = 0u16;
    let mut revision = 0u32;
    // SAFETY: `descriptor` is a live security descriptor from Windows.
    if unsafe { GetSecurityDescriptorControl(descriptor, &mut control, &mut revision) } == 0 {
        return Err(io::Error::last_os_error());
    }
    if control & SE_DACL_PROTECTED == 0 {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "Relay V2 storage DACL still inherits permissions",
        ));
    }
    let mut info = ACL_SIZE_INFORMATION::default();
    // SAFETY: `dacl` is live and `info` has the exact requested layout.
    if unsafe {
        GetAclInformation(
            dacl,
            (&mut info as *mut ACL_SIZE_INFORMATION).cast(),
            std::mem::size_of::<ACL_SIZE_INFORMATION>() as u32,
            AclSizeInformation,
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    if info.AceCount != 1 {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "Relay V2 storage DACL is not owner-only",
        ));
    }
    let mut ace_pointer: *mut c_void = ptr::null_mut();
    // SAFETY: index zero exists because the DACL reports exactly one ACE.
    if unsafe { GetAce(dacl, 0, &mut ace_pointer) } == 0 || ace_pointer.is_null() {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: GetAce returned a pointer to a complete ACE owned by `descriptor`.
    let ace = unsafe { &*(ace_pointer.cast::<ACCESS_ALLOWED_ACE>()) };
    let expected_flags = if directory {
        SUB_CONTAINERS_AND_OBJECTS_INHERIT as u8
    } else {
        NO_INHERITANCE as u8
    };
    if ace.Header.AceType != ACCESS_ALLOWED_ACE_TYPE
        || ace.Header.AceFlags != expected_flags
        || ace.Header.AceFlags & INHERITED_ACE as u8 != 0
        || ace.Header.AceSize < std::mem::size_of::<ACCESS_ALLOWED_ACE>() as u16
        || ace.Mask != FILE_ALL_ACCESS
    {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "Relay V2 storage has an unexpected access-control entry",
        ));
    }
    let ace_sid = (&ace.SidStart as *const u32).cast_mut().cast::<c_void>();
    let sid_offset = std::mem::offset_of!(ACCESS_ALLOWED_ACE, SidStart);
    let sid_available = (ace.Header.AceSize as usize).saturating_sub(sid_offset);
    const SID_FIXED_BYTES: usize = 8;
    if sid_available < SID_FIXED_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "Relay V2 storage ACE has an invalid SID length",
        ));
    }
    // Read only the fixed SID header before asking Windows to validate it. A
    // corrupted SubAuthorityCount must not make IsValidSid/GetLengthSid read
    // past this ACE.
    let sub_authority_count = unsafe { *ace_sid.cast::<u8>().add(1) } as usize;
    let declared_sid_length = SID_FIXED_BYTES
        .checked_add(sub_authority_count.saturating_mul(std::mem::size_of::<u32>()))
        .ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::PermissionDenied,
                "Relay V2 storage ACE has an invalid SID length",
            )
        })?;
    if sid_available != declared_sid_length
        || unsafe { IsValidSid(ace_sid) } == 0
        || unsafe { GetLengthSid(ace_sid) } as usize != declared_sid_length
    {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "Relay V2 storage ACE has an invalid SID",
        ));
    }
    // SAFETY: an ACCESS_ALLOWED_ACE stores its SID beginning at SidStart.
    if unsafe { EqualSid(ace_sid, token_user.sid()) } == 0 {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "Relay V2 storage grants access to a non-owner SID",
        ));
    }
    Ok(())
}

#[allow(dead_code)] // SQLCipher includes this module but has no replaceable JSON ledger.
pub fn atomic_replace(source: &Path, destination: &Path) -> io::Result<()> {
    let source = nul_terminated_path(source)?;
    let destination = nul_terminated_path(destination)?;
    // SAFETY: both paths are NUL-terminated and remain live for the call. The
    // two paths share one media root, so replacement is an atomic same-volume
    // metadata operation; WRITE_THROUGH also durably completes any copy
    // fallback Windows performs.
    if unsafe {
        MoveFileExW(
            source.as_ptr(),
            destination.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

fn nul_terminated_path(path: &Path) -> io::Result<Vec<u16>> {
    let mut wide = path.as_os_str().encode_wide().collect::<Vec<_>>();
    if wide.contains(&0) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Windows storage path contains NUL",
        ));
    }
    wide.push(0);
    Ok(wide)
}

fn win32_status(operation: &str, status: u32) -> io::Error {
    io::Error::new(
        io::ErrorKind::PermissionDenied,
        format!("{operation} failed with Windows status {status}"),
    )
}

struct CurrentTokenUser {
    _storage: Vec<usize>,
    sid: PSID,
}

impl CurrentTokenUser {
    fn load() -> io::Result<Self> {
        let mut token: HANDLE = ptr::null_mut();
        // SAFETY: the process pseudo-handle is always valid, and `token` is a
        // valid out pointer.
        if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0 {
            return Err(io::Error::last_os_error());
        }
        let token = OwnedHandle(token);
        let mut required = 0u32;
        // SAFETY: the documented sizing call uses a null destination.
        let first =
            unsafe { GetTokenInformation(token.0, TokenUser, ptr::null_mut(), 0, &mut required) };
        if first != 0
            || required == 0
            || io::Error::last_os_error()
                .raw_os_error()
                .map(|code| code as u32)
                != Some(ERROR_INSUFFICIENT_BUFFER)
        {
            return Err(io::Error::last_os_error());
        }
        let words = (required as usize).div_ceil(std::mem::size_of::<usize>());
        let mut storage = vec![0usize; words];
        // SAFETY: the word buffer is pointer-aligned and has at least `required`
        // writable bytes. Windows initializes a TOKEN_USER within it.
        if unsafe {
            GetTokenInformation(
                token.0,
                TokenUser,
                storage.as_mut_ptr().cast(),
                required,
                &mut required,
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: the successful call above initialized TOKEN_USER at the start
        // of the aligned buffer.
        let user = unsafe { &*(storage.as_ptr().cast::<TOKEN_USER>()) };
        if user.User.Sid.is_null() {
            return Err(io::Error::other("current token has no user SID"));
        }
        Ok(Self {
            _storage: storage,
            sid: user.User.Sid,
        })
    }

    fn sid(&self) -> PSID {
        self.sid
    }
}

struct OwnedHandle(HANDLE);

impl Drop for OwnedHandle {
    fn drop(&mut self) {
        if !self.0.is_null() {
            // SAFETY: this wrapper owns the token handle.
            unsafe { CloseHandle(self.0) };
        }
    }
}

struct LocalAllocation(*mut c_void);

impl Drop for LocalAllocation {
    fn drop(&mut self) {
        if !self.0.is_null() {
            // SAFETY: SetEntriesInAclW/GetNamedSecurityInfoW allocate these
            // buffers with LocalAlloc and transfer ownership to the caller.
            unsafe { LocalFree(self.0) };
        }
    }
}
