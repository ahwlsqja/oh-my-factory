"""Runs one command on a pseudo terminal and types one line into it.

usage: tty-run.py <line to type> <command> [args...]

omf refuses J-decisions without an interactive terminal (spec 6.2), so the outer suite needs a real one to
reach the steps that only a person can do. The line is queued before the command reads, which the terminal
buffers; the combined output goes to stdout and the exit code is the command's. Standard library only.
"""
import os
import pty
import sys

line, command = sys.argv[1], sys.argv[2:]
pid, fd = pty.fork()
if pid == 0:
    os.execvp(command[0], command)
os.write(fd, (line + "\n").encode())
output = b""
while True:
    try:
        data = os.read(fd, 4096)
    except OSError:
        break
    if not data:
        break
    output += data
_, status = os.waitpid(pid, 0)
sys.stdout.buffer.write(output)
sys.stdout.buffer.flush()
sys.exit(os.waitstatus_to_exitcode(status))
