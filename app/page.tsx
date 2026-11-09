import { Home } from "@/components/Home";
import { getListings } from "@/lib/data";

export const revalidate = 3600;

export default async function Page() {
  return <Home roles={await getListings()} />;
}
