import { useEffect, useReducer } from "react";
import { callManager } from "./call";

// Re-renders the consumer whenever the call manager's state changes.
export function useCall() {
  const [, force] = useReducer((x) => x + 1, 0);
  useEffect(() => callManager.subscribe(force), []);
  return callManager;
}
