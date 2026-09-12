import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Center, Grid, Inline, Inset, Stack } from "./index";

describe("layout primitives", () => {
  it("exposes spacing and alignment choices as typed data attributes", () => {
    const html = renderToStaticMarkup(
      <Stack gap="xl" align="center">
        <Inline gap="xs" justify="between" wrap>
          <span>A</span>
          <span>B</span>
        </Inline>
      </Stack>,
    );

    expect(html).toContain('data-gap="xl"');
    expect(html).toContain('data-align="center"');
    expect(html).toContain('data-gap="xs"');
    expect(html).toContain('data-justify="between"');
    expect(html).toContain('data-wrap="true"');
  });

  it("keeps inset, center, and grid responsibilities explicit", () => {
    const html = renderToStaticMarkup(
      <Center size="lg" gutter="lg">
        <Inset space="xl">
          <Grid columns={3} gap="md" responsive={false}>content</Grid>
        </Inset>
      </Center>,
    );

    expect(html).toContain('data-size="lg"');
    expect(html).toContain('data-gutter="lg"');
    expect(html).toContain('data-space="xl"');
    expect(html).toContain('data-columns="3"');
    expect(html).toContain('data-responsive="false"');
  });
});
