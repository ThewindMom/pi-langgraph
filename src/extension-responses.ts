export function actionEnvelope<T>(text: string, details: T) {
  return { content: [{ type: "text" as const, text }], details };
}

export function renderProgress(progress: {
  readonly taskId: string;
  readonly status: string;
  readonly completed: number;
  readonly total: number;
}): string {
  return `${progress.taskId}: ${progress.status} (${progress.completed}/${progress.total})`;
}
