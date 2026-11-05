#!/usr/bin/env python3
"""ptyrun: run a command on a fresh pseudo-terminal (pty) and proxy its
stdin/stdout through OUR stdin/stdout (which may be pipes). This lets the test
harness drive interactive terminal programs without a controlling TTY.

usage: ptyrun.py [--rows N] [--cols N] -- <cmd> [args...]
stdlib only (pty, select); MIT.
"""
import os
import pty
import select
import signal
import sys
import termios


def main() -> int:
    args = sys.argv[1:]
    rows, cols = 40, 120
    if args and args[0] == "--rows":
        rows = int(args[1]); args = args[2:]
    if args and args[0] == "--cols":
        cols = int(args[1]); args = args[2:]
    if args and args[0] == "--":
        args = args[1:]
    if not args:
        print("ptyrun: no command", file=sys.stderr)
        return 2

    pid, fd = pty.fork()
    if pid == 0:
        try:
            os.execvp(args[0], args)
        except Exception as exc:  # noqa: BLE001
            print(f"ptyrun: exec failed: {exc}", file=sys.stderr)
            os._exit(127)

    try:
        tios = termios.tcgetattr(fd)
        tios[0] |= termios.IGNBRK | termios.BRKINT | termios.PARMRK | termios.ISTRIP
        termios.tcsetattr(fd, termios.TCSANOW, tios)
        winsize = rows.to_bytes(2, "big") + cols.to_bytes(2, "big") + b"\x00\x00\x00\x00"
        fcntl = __import__("fcntl")
        fcntl.ioctl(fd, termios.TIOCSWINSZ, winsize)
    except Exception:
        pass

    def forward(sig, frm):
        try:
            os.kill(pid, sig)
        except ProcessLookupError:
            pass

    signal.signal(signal.SIGTERM, forward)
    signal.signal(signal.SIGINT, forward)

    stdin_fd = 0
    try:
        while True:
            r, _, _ = select.select([fd, stdin_fd], [], [], 0.2)
            if fd in r:
                try:
                    data = os.read(fd, 65536)
                except OSError:
                    break
                if not data:
                    break
                try:
                    os.write(1, data)
                except OSError:
                    break
            if stdin_fd in r:
                try:
                    data = os.read(stdin_fd, 65536)
                except OSError:
                    data = b""
                if not data:
                    pass
                else:
                    os.write(fd, data)
            done_pid, status = os.waitpid(pid, os.WNOHANG)
            if done_pid:
                # drain remaining output
                while True:
                    r2, _, _ = select.select([fd], [], [], 0.1)
                    if not r2:
                        break
                    try:
                        d = os.read(fd, 65536)
                    except OSError:
                        break
                    if not d:
                        break
                    os.write(1, d)
                return os.waitstatus_to_exitcode(status) & 0xFF
    except KeyboardInterrupt:
        try:
            os.kill(pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
    finally:
        try:
            os.close(fd)
        except OSError:
            pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
