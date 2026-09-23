// Guards `-[NSApplication sendEvent:]` against Objective-C exceptions.
//
// tao (Tauri's window layer) subclasses NSApplication and overrides `sendEvent:`
// with an `extern "C"` Rust function. The app is built with `panic = "abort"`,
// and under that strategy no Rust-defined frame may propagate a foreign
// exception, so any NSException raised by AppKit while it dispatches an event
// hits Rust's abort landing pad and kills the app. macOS 27.0 does exactly that
// from its hover UI (`NSCampoLightweightUIController.m:1429` assertion on
// mouse-enter), which crashed agmux on 2026-09-05 and 2026-09-07.
//
// A plain Cocoa app survives this because AppKit's run loop catches the
// exception, logs it, and moves on. This shim restores that behavior: it
// replaces tao's override with the same logic (tao forwards Cmd+key keyUp
// events to the key window by hand, then calls super) wrapped in @try/@catch.
// The catch lives in Objective-C, so no Rust frame sits between the throw and
// the handler. Caught exceptions are reported to Rust (see src/appkit_guard.rs)
// and to the unified log.
//
// NSApp is KVO-observed at runtime, so its concrete class is a hidden
// `NSKVONotifying_*` subclass that defines no sendEvent: of its own. The
// installer therefore walks up from the concrete class to the first class that
// defines sendEvent: itself (tao's) and patches that one, and the super call
// targets that class's superclass rather than `object_getClass(self)`'s, which
// would recurse into this guard.
//
// tao's device-event dispatch (raw mouse motion) is intentionally not
// replicated: tauri-runtime-wry never consumes `Event::DeviceEvent`.

#import <AppKit/AppKit.h>
#import <objc/message.h>
#import <objc/runtime.h>
#include <stdlib.h>

typedef void (*agmux_exception_reporter)(const char *name, const char *reason);

static agmux_exception_reporter g_reporter = NULL;
static Class g_super_class = Nil;

static void guarded_send_event(NSApplication *self, SEL _cmd, NSEvent *event) {
    @try {
        if (event.type == NSEventTypeKeyUp &&
            (event.modifierFlags & NSEventModifierFlagCommand) != 0) {
            // Holding Cmd + any key never delivers keyUp to the key window on
            // its own; tao forwards it explicitly (StackOverflow 15294196).
            NSWindow *keyWindow = self.keyWindow;
            if (keyWindow != nil) {
                [keyWindow sendEvent:event];
            }
        } else {
            struct objc_super target = {self, g_super_class};
            ((void (*)(struct objc_super *, SEL, NSEvent *))objc_msgSendSuper)(&target, _cmd, event);
        }
    } @catch (NSException *exception) {
        NSLog(@"agmux: caught Objective-C exception in sendEvent: %@: %@",
              exception.name, exception.reason);
        if (g_reporter != NULL) {
            const char *name = exception.name.UTF8String;
            const char *reason = exception.reason.UTF8String;
            g_reporter(name != NULL ? name : "", reason != NULL ? reason : "");
        }
    }
}

static BOOL class_defines_selector(Class cls, SEL selector) {
    unsigned int count = 0;
    Method *methods = class_copyMethodList(cls, &count);
    BOOL found = NO;
    for (unsigned int i = 0; i < count && !found; i++) {
        found = method_getName(methods[i]) == selector;
    }
    free(methods);
    return found;
}

// First class between `concrete` (inclusive) and NSApplication (exclusive)
// that implements sendEvent: itself, or Nil when no subclass overrides it.
static Class class_overriding_send_event(Class concrete) {
    Class base = [NSApplication class];
    for (Class cls = concrete; cls != Nil && cls != base; cls = class_getSuperclass(cls)) {
        if (class_defines_selector(cls, @selector(sendEvent:))) {
            return cls;
        }
    }
    return Nil;
}

// Installs the guard on the subclass of NSApplication that overrides
// sendEvent:. Must run on the main thread after the application object exists
// (Tauri's `setup` is fine).
//
// Returns:
//   0  installed (or already installed)
//   1  NSApp does not exist yet
//   2  NSApp is a plain NSApplication (no Rust override to guard)
//   3  no subclass overrides sendEvent:; nothing patched
int agmux_install_send_event_guard(agmux_exception_reporter reporter) {
    NSApplication *app = NSApp;
    if (app == nil) {
        return 1;
    }
    Class concrete = object_getClass(app);
    if (concrete == [NSApplication class]) {
        return 2;
    }
    Class target = class_overriding_send_event(concrete);
    if (target == Nil) {
        return 3;
    }
    Method method = class_getInstanceMethod(target, @selector(sendEvent:));
    if (method_getImplementation(method) == (IMP)guarded_send_event) {
        return 0;
    }
    g_reporter = reporter;
    g_super_class = class_getSuperclass(target);
    class_replaceMethod(target, @selector(sendEvent:), (IMP)guarded_send_event,
                        method_getTypeEncoding(method));
    NSLog(@"agmux: sendEvent exception guard installed on %s (NSApp is %s, super is %s)",
          class_getName(target), class_getName(concrete), class_getName(g_super_class));
    return 0;
}
