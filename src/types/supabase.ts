export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      creator_profiles: {
        Row: {
          bio: string | null
          country: string | null
          created_at: string
          display_name: string | null
          instagram_avg_views_last_10: number | null
          instagram_follower_count: number | null
          instagram_media_count: number | null
          metrics_fetched_at: string | null
          tiktok_avg_views_last_10: number | null
          tiktok_follower_count: number | null
          tiktok_is_verified: boolean | null
          tiktok_total_likes: number | null
          tiktok_video_count: number | null
          updated_at: string
          user_id: string
        }
        Insert: {
          bio?: string | null
          country?: string | null
          created_at?: string
          display_name?: string | null
          instagram_avg_views_last_10?: number | null
          instagram_follower_count?: number | null
          instagram_media_count?: number | null
          metrics_fetched_at?: string | null
          tiktok_avg_views_last_10?: number | null
          tiktok_follower_count?: number | null
          tiktok_is_verified?: boolean | null
          tiktok_total_likes?: number | null
          tiktok_video_count?: number | null
          updated_at?: string
          user_id: string
        }
        Update: {
          bio?: string | null
          country?: string | null
          created_at?: string
          display_name?: string | null
          instagram_avg_views_last_10?: number | null
          instagram_follower_count?: number | null
          instagram_media_count?: number | null
          metrics_fetched_at?: string | null
          tiktok_avg_views_last_10?: number | null
          tiktok_follower_count?: number | null
          tiktok_is_verified?: boolean | null
          tiktok_total_likes?: number | null
          tiktok_video_count?: number | null
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "creator_profiles_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: true
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      lister_profiles: {
        Row: {
          created_at: string
          description: string | null
          logo_path: string | null
          org_name: string
          updated_at: string
          user_id: string
          website_url: string | null
        }
        Insert: {
          created_at?: string
          description?: string | null
          logo_path?: string | null
          org_name: string
          updated_at?: string
          user_id: string
          website_url?: string | null
        }
        Update: {
          created_at?: string
          description?: string | null
          logo_path?: string | null
          org_name?: string
          updated_at?: string
          user_id?: string
          website_url?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "lister_profiles_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: true
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      social_links: {
        Row: {
          created_at: string
          fail_count: number
          handle: string
          handle_confirmed_at: string | null
          id: string
          last_scrape_attempt_at: string | null
          last_scrape_error: string | null
          last_scrape_run_id: string | null
          platform: Database["public"]["Enums"]["platform"]
          status: Database["public"]["Enums"]["social_link_status"]
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          fail_count?: number
          handle: string
          handle_confirmed_at?: string | null
          id?: string
          last_scrape_attempt_at?: string | null
          last_scrape_error?: string | null
          last_scrape_run_id?: string | null
          platform: Database["public"]["Enums"]["platform"]
          status?: Database["public"]["Enums"]["social_link_status"]
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          fail_count?: number
          handle?: string
          handle_confirmed_at?: string | null
          id?: string
          last_scrape_attempt_at?: string | null
          last_scrape_error?: string | null
          last_scrape_run_id?: string | null
          platform?: Database["public"]["Enums"]["platform"]
          status?: Database["public"]["Enums"]["social_link_status"]
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "social_links_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      users: {
        Row: {
          created_at: string
          deleted_at: string | null
          email: string | null
          id: string
          role: Database["public"]["Enums"]["user_role"]
          updated_at: string
          username: string
        }
        Insert: {
          created_at?: string
          deleted_at?: string | null
          email?: string | null
          id?: string
          role: Database["public"]["Enums"]["user_role"]
          updated_at?: string
          username: string
        }
        Update: {
          created_at?: string
          deleted_at?: string | null
          email?: string | null
          id?: string
          role?: Database["public"]["Enums"]["user_role"]
          updated_at?: string
          username?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      [_ in never]: never
    }
    Enums: {
      application_status:
        | "pending"
        | "approved"
        | "rejected"
        | "withdrawn"
        | "cancelled_listing_edit"
        | "cancelled_listing_closed"
      condition_kind: "pre" | "post"
      condition_metric:
        | "min_followers"
        | "min_avg_views_last_n"
        | "min_total_likes"
        | "min_videos_posted"
        | "verified_only"
        | "post_min_video_duration_sec"
        | "post_max_video_duration_sec"
        | "post_min_video_count"
        | "post_must_mention"
        | "post_family_friendly"
        | "post_must_tag_account"
      listing_status: "draft" | "active" | "paused" | "closed" | "archived"
      metric_status: "fresh" | "stale" | "refreshing" | "failed"
      notification_kind:
        | "application_approved"
        | "application_rejected"
        | "application_cancelled"
        | "submission_received"
        | "submission_approved"
        | "submission_rejected"
        | "listing_version_changed"
        | "metrics_refresh_failed"
      platform: "tiktok" | "instagram"
      scrape_mode: "tiktok_profile" | "ig_details" | "ig_posts"
      social_link_status: "linked" | "unlinked" | "failed_fetch"
      submission_status: "pending" | "approved" | "rejected"
      user_role: "creator" | "lister"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      application_status: [
        "pending",
        "approved",
        "rejected",
        "withdrawn",
        "cancelled_listing_edit",
        "cancelled_listing_closed",
      ],
      condition_kind: ["pre", "post"],
      condition_metric: [
        "min_followers",
        "min_avg_views_last_n",
        "min_total_likes",
        "min_videos_posted",
        "verified_only",
        "post_min_video_duration_sec",
        "post_max_video_duration_sec",
        "post_min_video_count",
        "post_must_mention",
        "post_family_friendly",
        "post_must_tag_account",
      ],
      listing_status: ["draft", "active", "paused", "closed", "archived"],
      metric_status: ["fresh", "stale", "refreshing", "failed"],
      notification_kind: [
        "application_approved",
        "application_rejected",
        "application_cancelled",
        "submission_received",
        "submission_approved",
        "submission_rejected",
        "listing_version_changed",
        "metrics_refresh_failed",
      ],
      platform: ["tiktok", "instagram"],
      scrape_mode: ["tiktok_profile", "ig_details", "ig_posts"],
      social_link_status: ["linked", "unlinked", "failed_fetch"],
      submission_status: ["pending", "approved", "rejected"],
      user_role: ["creator", "lister"],
    },
  },
} as const
