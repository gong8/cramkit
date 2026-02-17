import { useCallback, useSyncExternalStore } from "react";

const STORAGE_KEY = "cramkit:chat-zoom";
const ZOOM_LEVELS = [75, 90, 100, 110, 125, 150] as const;
const DEFAULT_ZOOM = 100;

const listeners = new Set<() => void>();

function getSnapshot(): number {
	const stored = localStorage.getItem(STORAGE_KEY);
	if (!stored) return DEFAULT_ZOOM;
	const val = Number(stored);
	return ZOOM_LEVELS.includes(val as (typeof ZOOM_LEVELS)[number]) ? val : DEFAULT_ZOOM;
}

function subscribe(cb: () => void) {
	listeners.add(cb);
	return () => listeners.delete(cb);
}

function setZoom(level: number) {
	localStorage.setItem(STORAGE_KEY, String(level));
	for (const cb of listeners) cb();
}

export function useChatZoom() {
	const zoom = useSyncExternalStore(subscribe, getSnapshot);

	const zoomIn = useCallback(() => {
		const idx = ZOOM_LEVELS.indexOf(zoom as (typeof ZOOM_LEVELS)[number]);
		if (idx < ZOOM_LEVELS.length - 1) setZoom(ZOOM_LEVELS[idx + 1]);
	}, [zoom]);

	const zoomOut = useCallback(() => {
		const idx = ZOOM_LEVELS.indexOf(zoom as (typeof ZOOM_LEVELS)[number]);
		if (idx > 0) setZoom(ZOOM_LEVELS[idx - 1]);
	}, [zoom]);

	const resetZoom = useCallback(() => setZoom(DEFAULT_ZOOM), []);

	return {
		zoom,
		zoomIn,
		zoomOut,
		resetZoom,
		canZoomIn: zoom < ZOOM_LEVELS[ZOOM_LEVELS.length - 1],
		canZoomOut: zoom > ZOOM_LEVELS[0],
		isDefault: zoom === DEFAULT_ZOOM,
	};
}
