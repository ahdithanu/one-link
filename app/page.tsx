import { Home } from "@/components/Home";
import { listings } from "@/lib/data";

export default function Page() {
  return <Home roles={listings} />;
}
