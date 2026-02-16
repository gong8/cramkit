import { createBrowserRouter } from "react-router-dom";
import { Layout } from "./components/Layout";
import { Dashboard } from "./pages/Dashboard";
import { NewSession } from "./pages/NewSession";
import { SessionDetail } from "./pages/SessionDetail";

export const router = createBrowserRouter([
	{
		element: <Layout />,
		children: [
			{ path: "/", element: <Dashboard /> },
			{ path: "/new", element: <NewSession /> },
			{ path: "/session/:id", element: <SessionDetail /> },
		],
	},
]);
