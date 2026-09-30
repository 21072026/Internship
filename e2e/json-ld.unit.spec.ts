// The JSON-LD escape (#1382). A structured-data string is dictionary copy or
// project data; a `</script>` inside it would close the tag and turn the rest
// into markup. Pure node — run with BASE_URL=http://localhost:9 to skip the
// webServer.
import { test, expect } from '@playwright/test';
import { jsonLdString } from '@/components/JsonLd';

test('a string cannot close the script tag, and the JSON still reads back unchanged', () => {
  const data = { name: 'Q&A </script><script>alert(1)</script>', note: 'line sep end', ok: 'plain' };
  const out = jsonLdString(data);
  expect(out).not.toMatch(/<|>|&/);
  expect(out).not.toContain(' ');
  expect(out).not.toContain(' ');
  expect(JSON.parse(out)).toEqual(data);
});
