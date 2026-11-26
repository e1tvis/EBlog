import { withAuth } from "next-auth/middleware";
import { NextResponse } from "next/server";

export default withAuth(
    function proxy() {
        return NextResponse.next();
    },
    {
        pages: { signIn: "/signin" },
    }
);

export const config = {
    matcher: ["/gallery/:path*"],
};
