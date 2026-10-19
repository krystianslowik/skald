//go:build unix

package saferestart

import "syscall"

// freeBytes is the space an unprivileged writer has left on dir's volume.
func freeBytes(dir string) (uint64, error) {
	var st syscall.Statfs_t
	if err := syscall.Statfs(dir, &st); err != nil {
		return 0, err
	}
	return uint64(st.Bavail) * uint64(st.Bsize), nil
}
