// Deliberately verbose generic to exercise the 200-char cap on the inferred
// fallback. No return annotation, so the extractor must fall back to the
// resolved type and apply the cap.
export function deeplyNested() {
  return new Map<
    string,
    Map<
      string,
      Map<string, Array<{ id: string; name: string; nested: { a: number; b: number; c: number } }>>
    >
  >();
}
