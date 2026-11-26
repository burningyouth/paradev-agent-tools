package sessionhost

// IsParadev reports whether the caller is running in a Paradev session.
func IsParadev(getenv func(string) string) bool {
	return getenv("ORCA_AGENT_SESSION_ID") == "" &&
		getenv("ORCA_STRUCTURED_SESSION") == "" &&
		getenv("SUPERSET_WORKSPACE_ID") != ""
}
