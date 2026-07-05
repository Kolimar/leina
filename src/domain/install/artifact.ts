// Shared install-writer return shape. All install writers are pure functions
// that produce one or more FileArtifacts; the CLI layer performs the actual
// filesystem writes.

export interface FileArtifact {
  // Repo-relative (or share-relative) path the installer should write.
  path: string;
  content: string;
}
