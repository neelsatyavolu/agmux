// Copyright 2020-2023 Tauri Programme within The Commons Conservancy
// SPDX-License-Identifier: Apache-2.0
// SPDX-License-Identifier: MIT

use std::{ffi::CStr, path::PathBuf};

use objc2::{
  runtime::{Bool, ProtocolObject},
  DeclaredClass,
};
// NSFilenamesPboardType is deprecated in favor of NSPasteboardTypeFileURL, but
// Finder drag still exposes the legacy type and wry's drop pipeline expects
// path strings. Keep reading it safely until we drop this vendor patch.
#[allow(deprecated)]
use objc2_app_kit::{NSDragOperation, NSDraggingInfo, NSFilenamesPboardType};
use objc2_foundation::{NSArray, NSPoint, NSRect, NSString};

use crate::DragDropEvent;

use super::WryWebView;

// Allow deprecated pasteboard type: see import note above.
#[allow(deprecated)]
pub(crate) unsafe fn collect_paths(drag_info: &ProtocolObject<dyn NSDraggingInfo>) -> Vec<PathBuf> {
  let pb = drag_info.draggingPasteboard();
  let mut drag_drop_paths = Vec::new();
  let types = NSArray::arrayWithObject(NSFilenamesPboardType);

  // Never unwrap here: on newer macOS (and some drag sources) the pasteboard
  // can advertise NSFilenamesPboardType while propertyListForType returns nil
  // or a non-array. Those unwraps panic on the main AppKit thread and, with
  // release panic=abort, hard-crash the whole app mid-drag.
  if pb.availableTypeFromArray(&types).is_some() {
    if let Some(paths) = pb.propertyListForType(NSFilenamesPboardType) {
      if let Ok(paths) = paths.downcast::<NSArray>() {
        for path in paths {
          let Ok(path) = path.downcast::<NSString>() else {
            continue;
          };
          let ptr = path.UTF8String();
          if ptr.is_null() {
            continue;
          }
          let path = CStr::from_ptr(ptr).to_string_lossy();
          if !path.is_empty() {
            drag_drop_paths.push(PathBuf::from(path.into_owned()));
          }
        }
      }
    }
  }
  drag_drop_paths
}

pub(crate) fn dragging_entered(
  this: &WryWebView,
  drag_info: &ProtocolObject<dyn NSDraggingInfo>,
) -> NSDragOperation {
  let paths = unsafe { collect_paths(drag_info) };
  let dl: NSPoint = drag_info.draggingLocation();
  let frame: NSRect = this.frame();
  let position = (dl.x as i32, (frame.size.height - dl.y) as i32);

  let listener = &this.ivars().drag_drop_handler;
  if !listener(DragDropEvent::Enter { paths, position }) {
    // Reject the Wry file drop (invoke the OS default behaviour)
    unsafe { objc2::msg_send![super(this), draggingEntered: drag_info] }
  } else {
    NSDragOperation::Copy
  }
}

pub(crate) fn dragging_updated(
  this: &WryWebView,
  drag_info: &ProtocolObject<dyn NSDraggingInfo>,
) -> NSDragOperation {
  let dl: NSPoint = drag_info.draggingLocation();
  let frame: NSRect = this.frame();
  let position = (dl.x as i32, (frame.size.height - dl.y) as i32);

  let listener = &this.ivars().drag_drop_handler;
  if !listener(DragDropEvent::Over { position }) {
    unsafe {
      let os_operation = objc2::msg_send![super(this), draggingUpdated: drag_info];
      if os_operation == NSDragOperation::None {
        // 0 will be returned for a drop on any arbitrary location on the webview.
        // We'll override that with NSDragOperationCopy.
        NSDragOperation::Copy
      } else {
        // A different NSDragOperation is returned when a file is hovered over something like
        // a <input type="file">, so we'll make sure to preserve that behaviour.
        os_operation
      }
    }
  } else {
    NSDragOperation::Copy
  }
}

pub(crate) fn perform_drag_operation(
  this: &WryWebView,
  drag_info: &ProtocolObject<dyn NSDraggingInfo>,
) -> Bool {
  let paths = unsafe { collect_paths(drag_info) };
  let dl: NSPoint = drag_info.draggingLocation();
  let frame: NSRect = this.frame();
  let position = (dl.x as i32, (frame.size.height - dl.y) as i32);

  let listener = &this.ivars().drag_drop_handler;
  if !listener(DragDropEvent::Drop { paths, position }) {
    // Reject the Wry drop (invoke the OS default behaviour)
    unsafe { objc2::msg_send![super(this), performDragOperation: drag_info] }
  } else {
    Bool::YES
  }
}

pub(crate) fn dragging_exited(this: &WryWebView, drag_info: &ProtocolObject<dyn NSDraggingInfo>) {
  let listener = &this.ivars().drag_drop_handler;
  if !listener(DragDropEvent::Leave) {
    // Reject the Wry drop (invoke the OS default behaviour)
    unsafe { objc2::msg_send![super(this), draggingExited: drag_info] }
  }
}
