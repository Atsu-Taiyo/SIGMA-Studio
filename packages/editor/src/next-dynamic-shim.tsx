import {
  Suspense,
  lazy,
  type ComponentType,
  type ReactNode,
} from "react";

interface DynamicOptions {
  loading?: () => ReactNode;
}

type DynamicModule<Props> =
  | { default: ComponentType<Props> }
  | ComponentType<Props>;

export default function dynamic<Props extends object>(
  loader: () => Promise<DynamicModule<Props>>,
  options: DynamicOptions = {},
): ComponentType<Props> {
  const LazyComponent = lazy(async () => {
    const loaded = await loader();
    return typeof loaded === "function" ? { default: loaded } : loaded;
  });

  return function DynamicComponent(props: Props) {
    return (
      <Suspense fallback={options.loading?.() ?? null}>
        <LazyComponent {...props} />
      </Suspense>
    );
  };
}
