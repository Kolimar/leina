// async function — isAsync=true, isGenerator=false.
export async function fetchUser(id: string): Promise<{ id: string }> {
  return { id };
}

// generator function — isAsync=false, isGenerator=true.
export function* counter(): Generator<number> {
  let i = 0;
  while (true) yield i++;
}

// async generator — both true.
export async function* streamUsers(): AsyncGenerator<{ id: string }> {
  yield { id: "1" };
}

// async arrow — isAsync=true via modifier check.
export const fetchOne = async (id: string): Promise<string> => {
  return id;
};
