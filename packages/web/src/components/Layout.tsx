import { Link, Outlet } from "react-router-dom";

export function Layout() {
	return (
		<div className="min-h-screen bg-background">
			<header className="border-b border-border">
				<div className="mx-auto flex h-14 max-w-5xl items-center px-4">
					<Link to="/" className="text-lg font-bold tracking-tight">
						CramKit
					</Link>
				</div>
			</header>
			<main className="mx-auto max-w-5xl px-4 py-8">
				<Outlet />
			</main>
		</div>
	);
}
