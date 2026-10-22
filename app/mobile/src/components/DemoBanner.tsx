import { StyleSheet, Text, View } from "react-native";
import { useQuery } from "convex/react";
import { api } from "../lib/convex";
import { COLORS } from "../theme";

/**
 * CR-16: render a visible banner whenever the echoed-OTP stub is compiled in. The flag is read
 * from the deployment, so a production build (which refuses to compile with echo on) can never
 * show a stale banner.
 */
export function DemoBanner() {
  const info = useQuery(api.auth.demo.buildInfo, {});
  if (info?.echoOtp !== true) return null;

  return (
    <View style={styles.banner} accessibilityRole="alert">
      <Text style={styles.text}>
        <Text style={styles.strong}>Demo build — not authentication.</Text> One-time codes are
        shown on screen, and anyone can sign in as any email address. Do not use real accounts or
        real data.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    backgroundColor: COLORS.warnBg,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: COLORS.warnBorder,
    paddingHorizontal: 14,
    paddingVertical: 9,
  },
  text: {
    color: COLORS.warnText,
    fontSize: 12,
    lineHeight: 17,
  },
  strong: {
    fontWeight: "700",
  },
});
