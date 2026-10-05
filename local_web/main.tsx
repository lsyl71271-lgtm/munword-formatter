/** Desktop mounts the EXACT same component/engine as the hosted homepage.
 * The local Python service serves assets and keeps its API/CLI compatibility;
 * it does not format documents for this UI. No separate desktop frontend.
 */
import { createRoot } from "react-dom/client";
import Home from "../app/page";

const root = document.getElementById("root");
if (!root) throw new Error("Munword page has no root element");
createRoot(root).render(<Home />);
