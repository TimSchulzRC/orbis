import type { ComponentProps } from "react";
import { useTheme } from "../theme";

/** The app mark follows the device's chosen app theme. */
export function BrandLogo(props: Omit<ComponentProps<"img">, "src">) {
  const { resolved } = useTheme();
  return <img alt="" {...props} src={resolved === "dark" ? "/icon-dark.svg" : "/icon.svg"} />;
}
