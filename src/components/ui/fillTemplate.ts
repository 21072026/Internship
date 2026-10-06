import { createElement, Fragment, type ReactNode } from 'react';

/**
 * `t.x.lastSeen` = "Last seen {when}" with an element in the slot:
 * `fillTemplate(t.x.lastSeen, { when: <RelativeTime date={d} /> })`.
 *
 * The string `.replace('{when}', …)` idiom can only splice text, so a
 * translated sentence could not carry a <RelativeTime> (and its hover) without
 * being cut into per-locale halves. Unknown `{slots}` are left as written.
 */
export function fillTemplate(template: string, slots: Record<string, ReactNode>): ReactNode[] {
  return template.split(/(\{\w+\})/).map((part, i) => {
    const name = /^\{(\w+)\}$/.exec(part)?.[1];
    return createElement(Fragment, { key: i }, name !== undefined && name in slots ? slots[name] : part);
  });
}
