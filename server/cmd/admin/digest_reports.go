package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"sort"
	"text/tabwriter"
	"time"

	"github.com/mezalabs/meza/internal/models"
	"github.com/mezalabs/meza/internal/store"
)

// cmdDigestReports prints a summary of open reports in the platform queue,
// suitable for piping into an ops notification channel (Slack, PagerDuty,
// email, etc.) from an external scheduler such as a Kubernetes CronJob.
//
// Designed to be invoked as `meza-admin digest-reports` daily. The output is
// stable, machine-friendly text. There is intentionally no Slack webhook
// integration here — different operators have different escalation paths,
// and adding a webhook coupling means another env var, secret rotation,
// retry policy, and unit-test surface area we don't need.
func cmdDigestReports(ctx context.Context, args []string, reportStore store.ReportStorer) {
	fs := flag.NewFlagSet("digest-reports", flag.ExitOnError)
	limit := fs.Int("limit", 200, "max reports to scan")
	fs.Parse(args)

	// V1 only digests the platform queue (server_id IS NULL). Per-server
	// digests are server-mod responsibility, surfaced via the in-app
	// ReportsSection panel.
	reports, _, err := reportStore.ListPlatformReports(ctx, models.ReportStatusOpen, "", *limit)
	if err != nil {
		fmt.Fprintf(os.Stderr, "list reports: %v\n", err)
		os.Exit(1)
	}

	if len(reports) == 0 {
		fmt.Println("No open reports in the platform queue.")
		return
	}

	// Aggregate by category.
	byCategory := make(map[string]int)
	var oldest *models.Report
	for _, r := range reports {
		byCategory[r.Category]++
		if oldest == nil || r.CreatedAt.Before(oldest.CreatedAt) {
			oldest = r
		}
	}

	now := time.Now()
	fmt.Printf("Meza reports digest — %s\n\n", now.UTC().Format(time.RFC3339))
	fmt.Printf("Total open in platform queue: %d (showing up to %d)\n", len(reports), *limit)
	if oldest != nil {
		age := now.Sub(oldest.CreatedAt).Truncate(time.Minute)
		fmt.Printf("Oldest open report: %s ago (%s)\n\n", age, oldest.ID)
	}

	// Print sorted breakdown by category.
	type cat struct {
		name  string
		count int
	}
	var cats []cat
	for k, v := range byCategory {
		cats = append(cats, cat{k, v})
	}
	sort.Slice(cats, func(i, j int) bool { return cats[i].count > cats[j].count })

	tw := tabwriter.NewWriter(os.Stdout, 0, 0, 2, ' ', 0)
	fmt.Fprintln(tw, "Category\tCount")
	fmt.Fprintln(tw, "--------\t-----")
	for _, c := range cats {
		fmt.Fprintf(tw, "%s\t%d\n", c.name, c.count)
	}
	tw.Flush()

	fmt.Printf("\nReview at: <your-app-url>/settings/platform/reports\n")
}
