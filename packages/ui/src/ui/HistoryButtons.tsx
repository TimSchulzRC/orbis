import { ArrowLeft, ArrowRight } from "lucide-react";
import { useHistoryWays } from "../hooks";
import { useT } from "../i18n";
import { IconButton } from "./primitives";

/** Back and forward through the pages opened, like a browser's: the desktop app has no toolbar. */
export function HistoryButtons({ forward }: { forward?: boolean }) {
	const { t } = useT();
	const ways = useHistoryWays();
	return (
		<>
			<IconButton
				disabled={!ways.back}
				icon={ArrowLeft}
				label={t("nav.back")}
				onClick={() => history.back()}
			/>
			{forward && (
				<IconButton
					disabled={!ways.forward}
					icon={ArrowRight}
					label={t("nav.forward")}
					onClick={() => history.forward()}
				/>
			)}
		</>
	);
}
