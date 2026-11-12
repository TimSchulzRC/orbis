// "New type": a name, then the type's page with "Edit type" over it.

import { useState } from "react";
import { createType } from "../actions";
import { Input } from "../components/ui/input";
import { useRepo, useSpaceId } from "../hooks";
import { useT } from "../i18n";
import { Button, Dialog } from "../ui/primitives";
import { SpaceScope } from "../ui/Spaces";
import { closeNewType, editType, useNewTypeOpen } from "../ui/type-edit";

/** The "New type" dialog, while it is open (openNewType). Lives once in the app. */
export function NewTypeHost() {
	const space = useNewTypeOpen();
	return space ? (
		<SpaceScope id={space}>
			<NewTypeDialog onClose={closeNewType} />
		</SpaceScope>
	) : null;
}

/** Without `onCreated` the type's page opens with "Edit type". */
export function NewTypeDialog({
	title,
	onClose,
	onCreated,
}: {
	title?: string;
	onClose: () => void;
	onCreated?: (id: string) => void;
}) {
	const { t } = useT();
	const repo = useRepo();
	const space = useSpaceId();
	const [name, setName] = useState("");
	const create = (e: React.FormEvent) => {
		e.preventDefault();
		const trimmed = name.trim();
		if (!trimmed) return;
		const id = createType(trimmed, repo);
		onClose();
		if (onCreated) onCreated(id);
		else editType(id, space, true);
	};
	return (
		<Dialog onClose={onClose} title={title ?? t("types.new")}>
			<form onSubmit={create}>
				<Input
					autoFocus
					onChange={(e) => setName(e.target.value)}
					placeholder={t("type.name")}
					value={name}
				/>
				<div className="mt-4 flex justify-end">
					<Button disabled={!name.trim()} type="submit" variant="primary">
						{t("types.create")}
					</Button>
				</div>
			</form>
		</Dialog>
	);
}
