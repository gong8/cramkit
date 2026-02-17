import { createBrowserRouter, Outlet } from "react-router-dom";
import { Layout } from "./components/Layout";
import { Chat } from "./pages/Chat";
import { Dashboard } from "./pages/Dashboard";
import { KnowledgeGraph } from "./pages/KnowledgeGraph";
import { NewSession } from "./pages/NewSession";
import { SessionDetail } from "./pages/SessionDetail";

function FullscreenLayout() {
	return (
		<div className="h-screen overflow-hidden bg-background">
			<Outlet />
		</div>
	);
}

export const router = createBrowserRouter([
	{
		element: <Layout />,
		children: [
			{ path: "/", element: <Dashboard /> },
			{ path: "/new", element: <NewSession /> },
			{ path: "/session/:id", element: <SessionDetail /> },
		],
	},
	{
		element: <FullscreenLayout />,
		children: [
			{ path: "/session/:id/graph", element: <KnowledgeGraph /> },
			{ path: "/session/:id/chat", element: <Chat /> },
		],
	},
]);
