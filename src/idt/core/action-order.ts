import type { Action } from './ir-schema.js';

export function findTriggerActionIndex(actions: Action[]): number {
  let triggerIndex = -1;
  for (let index = 0; index < actions.length; index++) {
    if (actions[index].triggersRequest) triggerIndex = index;
  }
  return triggerIndex >= 0 ? triggerIndex : actions.length - 1;
}
