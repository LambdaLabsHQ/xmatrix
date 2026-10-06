use std::fs::File;
use std::io::{Read, Write};
use std::mem::size_of;
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle, RawHandle};

use windows_sys::Win32::Foundation::{HANDLE, HANDLE_FLAG_INHERIT, SetHandleInformation};
use windows_sys::Win32::Security::SECURITY_ATTRIBUTES;
use windows_sys::Win32::System::Pipes::CreatePipe;

use crate::{
    AuthenticatedControlFrame, ContinuityError, ControlMessage, decode_authenticated_frame,
    decode_frame, encode_authenticated_frame, encode_frame,
};

pub const CONTROL_READ_HANDLE_ENV: &str = "XMATRIX_SUPERVISOR_CONTROL_READ_HANDLE";
pub const CONTROL_WRITE_HANDLE_ENV: &str = "XMATRIX_SUPERVISOR_CONTROL_WRITE_HANDLE";
pub const CONTROL_PROTOCOL_ENV: &str = "XMATRIX_SUPERVISOR_CONTROL_PROTOCOL";

pub struct InheritedControlPipe {
    reader: File,
    writer: File,
    child: Option<ChildControlHandles>,
}

pub struct ChildControlHandles {
    read: OwnedHandle,
    write: OwnedHandle,
}

impl InheritedControlPipe {
    pub fn create() -> Result<Self, ContinuityError> {
        let (parent_read, child_write) = create_one_way_pipe()?;
        let (child_read, parent_write) = create_one_way_pipe()?;
        clear_inherit(parent_read.as_raw_handle() as HANDLE)?;
        clear_inherit(parent_write.as_raw_handle() as HANDLE)?;
        Ok(Self {
            reader: File::from(parent_read),
            writer: File::from(parent_write),
            child: Some(ChildControlHandles {
                read: child_read,
                write: child_write,
            }),
        })
    }

    pub fn try_clone(&self) -> Result<Self, ContinuityError> {
        Ok(Self {
            reader: self.reader.try_clone()?,
            writer: self.writer.try_clone()?,
            child: None,
        })
    }

    pub fn child_handles(&self) -> Result<&ChildControlHandles, ContinuityError> {
        self.child.as_ref().ok_or(ContinuityError::Invalid(
            "control child handles were already released",
        ))
    }

    pub fn release_child_handles(&mut self) {
        self.child.take();
    }

    pub fn send(&mut self, message: &ControlMessage) -> Result<(), ContinuityError> {
        self.writer.write_all(&encode_frame(message)?)?;
        self.writer.flush()?;
        Ok(())
    }

    pub fn receive(&mut self) -> Result<ControlMessage, ContinuityError> {
        decode_frame(&mut self.reader)
    }

    pub fn send_authenticated(
        &mut self,
        frame: &AuthenticatedControlFrame,
    ) -> Result<(), ContinuityError> {
        self.writer.write_all(&encode_authenticated_frame(frame)?)?;
        self.writer.flush()?;
        Ok(())
    }

    pub fn receive_authenticated(&mut self) -> Result<AuthenticatedControlFrame, ContinuityError> {
        decode_authenticated_frame(&mut self.reader)
    }
}

impl ChildControlHandles {
    pub fn apply(&self, command: &mut std::process::Command) {
        command
            .env(CONTROL_PROTOCOL_ENV, "1")
            .env(CONTROL_READ_HANDLE_ENV, handle_value(&self.read))
            .env(CONTROL_WRITE_HANDLE_ENV, handle_value(&self.write));
    }
}

pub fn connect_inherited_control_pipe() -> Result<InheritedControlPipe, ContinuityError> {
    if std::env::var(CONTROL_PROTOCOL_ENV).ok().as_deref() != Some("1") {
        return Err(ContinuityError::Invalid(
            "inherited control protocol is unavailable",
        ));
    }
    let read = inherited_file(CONTROL_READ_HANDLE_ENV)?;
    let write = inherited_file(CONTROL_WRITE_HANDLE_ENV)?;
    Ok(InheritedControlPipe {
        reader: read,
        writer: write,
        child: None,
    })
}

fn create_one_way_pipe() -> Result<(OwnedHandle, OwnedHandle), ContinuityError> {
    let mut read: HANDLE = std::ptr::null_mut();
    let mut write: HANDLE = std::ptr::null_mut();
    let mut attributes = SECURITY_ATTRIBUTES {
        nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: std::ptr::null_mut(),
        bInheritHandle: 1,
    };
    if unsafe { CreatePipe(&mut read, &mut write, &mut attributes, 0) } == 0 {
        return Err(ContinuityError::Io(std::io::Error::last_os_error()));
    }
    Ok((
        unsafe { OwnedHandle::from_raw_handle(read as RawHandle) },
        unsafe { OwnedHandle::from_raw_handle(write as RawHandle) },
    ))
}

fn clear_inherit(handle: HANDLE) -> Result<(), ContinuityError> {
    if unsafe { SetHandleInformation(handle, HANDLE_FLAG_INHERIT, 0) } == 0 {
        return Err(ContinuityError::Io(std::io::Error::last_os_error()));
    }
    Ok(())
}

fn handle_value(handle: &OwnedHandle) -> String {
    (handle.as_raw_handle() as usize).to_string()
}

fn inherited_file(name: &str) -> Result<File, ContinuityError> {
    let value = std::env::var(name)
        .map_err(|_| ContinuityError::Invalid("inherited control handle is missing"))?;
    let raw = value
        .parse::<usize>()
        .map_err(|_| ContinuityError::Invalid("inherited control handle is invalid"))?;
    if raw == 0 {
        return Err(ContinuityError::Invalid("inherited control handle is null"));
    }
    clear_inherit(raw as HANDLE)?;
    Ok(unsafe { File::from_raw_handle(raw as RawHandle) })
}

impl Read for InheritedControlPipe {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        self.reader.read(buffer)
    }
}

impl Write for InheritedControlPipe {
    fn write(&mut self, buffer: &[u8]) -> std::io::Result<usize> {
        self.writer.write(buffer)
    }

    fn flush(&mut self) -> std::io::Result<()> {
        self.writer.flush()
    }
}
