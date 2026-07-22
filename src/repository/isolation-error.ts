export class RepositoryIsolationError extends Error {
  readonly violation: "read-only" | "scope" | "source-conflict";

  constructor(violation: RepositoryIsolationError["violation"], message: string) {
    super(message);
    this.name = "RepositoryIsolationError";
    this.violation = violation;
  }
}
