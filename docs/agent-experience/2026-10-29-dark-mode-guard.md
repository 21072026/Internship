# 2026-10-29 — Dark-mode guard (#1614, part 1)

- **`ts.forEachChild(node, (c) => recurse(c, out))` stops after the first child** when `recurse`
  returns a truthy value (an array does). Use a block body. The unit test caught it; the tree scan
  looked "clean" with the bug in.
- **A flat `html.dark .bg-…` rule outranks every `dark:bg-…` on an element** ((0,2,1) vs (0,2,0)).
  Before retinting a utility globally, grep the elements that pair it with their own dark colour
  and land on that colour — or fix the one element instead.
- **The retint layer can be read back from `globals.css`** with one regex
  (`html\.dark \.((?:[A-Za-z0-9_-]|\\.)+)(?=[\s{,>:])`), so a guard never needs its own list.
