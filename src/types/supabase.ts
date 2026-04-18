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
      applications: {
        Row: {
          cover_note: string | null
          created_at: string
          creator_id: string
          decided_at: string | null
          decision_note: string | null
          id: string
          listing_id: string
          listing_version_id: string
          status: Database["public"]["Enums"]["application_status"]
          updated_at: string
        }
        Insert: {
          cover_note?: string | null
          created_at?: string
          creator_id: string
          decided_at?: string | null
          decision_note?: string | null
          id?: string
          listing_id: string
          listing_version_id: string
          status?: Database["public"]["Enums"]["application_status"]
          updated_at?: string
        }
        Update: {
          cover_note?: string | null
          created_at?: string
          creator_id?: string
          decided_at?: string | null
          decision_note?: string | null
          id?: string
          listing_id?: string
          listing_version_id?: string
          status?: Database["public"]["Enums"]["application_status"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "applications_creator_id_fkey"
            columns: ["creator_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "applications_listing_id_fkey"
            columns: ["listing_id"]
            isOneToOne: false
            referencedRelation: "listings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "applications_listing_version_id_fkey"
            columns: ["listing_version_id"]
            isOneToOne: false
            referencedRelation: "listing_versions"
            referencedColumns: ["id"]
          },
        ]
      }
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
      events: {
        Row: {
          action: string
          actor_id: string | null
          created_at: string
          entity: string
          entity_id: string
          id: number
          new_state: Json | null
          old_state: Json | null
        }
        Insert: {
          action: string
          actor_id?: string | null
          created_at?: string
          entity: string
          entity_id: string
          id?: number
          new_state?: Json | null
          old_state?: Json | null
        }
        Update: {
          action?: string
          actor_id?: string | null
          created_at?: string
          entity?: string
          entity_id?: string
          id?: number
          new_state?: Json | null
          old_state?: Json | null
        }
        Relationships: []
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
      listing_conditions: {
        Row: {
          bool_threshold: boolean | null
          created_at: string
          id: string
          kind: Database["public"]["Enums"]["condition_kind"]
          listing_version_id: string
          metric: Database["public"]["Enums"]["condition_metric"]
          numeric_threshold: number | null
          operator: string
          platform: Database["public"]["Enums"]["platform"] | null
          text_threshold: string | null
        }
        Insert: {
          bool_threshold?: boolean | null
          created_at?: string
          id?: string
          kind: Database["public"]["Enums"]["condition_kind"]
          listing_version_id: string
          metric: Database["public"]["Enums"]["condition_metric"]
          numeric_threshold?: number | null
          operator?: string
          platform?: Database["public"]["Enums"]["platform"] | null
          text_threshold?: string | null
        }
        Update: {
          bool_threshold?: boolean | null
          created_at?: string
          id?: string
          kind?: Database["public"]["Enums"]["condition_kind"]
          listing_version_id?: string
          metric?: Database["public"]["Enums"]["condition_metric"]
          numeric_threshold?: number | null
          operator?: string
          platform?: Database["public"]["Enums"]["platform"] | null
          text_threshold?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "listing_conditions_listing_version_id_fkey"
            columns: ["listing_version_id"]
            isOneToOne: false
            referencedRelation: "listing_versions"
            referencedColumns: ["id"]
          },
        ]
      }
      listing_versions: {
        Row: {
          changed_fields: string[]
          created_at: string
          currency: string
          id: string
          listing_id: string
          max_submissions: number | null
          previous_version_id: string | null
          price_cents: number
          snapshot: Json
          version_number: number
        }
        Insert: {
          changed_fields?: string[]
          created_at?: string
          currency: string
          id?: string
          listing_id: string
          max_submissions?: number | null
          previous_version_id?: string | null
          price_cents: number
          snapshot: Json
          version_number: number
        }
        Update: {
          changed_fields?: string[]
          created_at?: string
          currency?: string
          id?: string
          listing_id?: string
          max_submissions?: number | null
          previous_version_id?: string | null
          price_cents?: number
          snapshot?: Json
          version_number?: number
        }
        Relationships: [
          {
            foreignKeyName: "listing_versions_listing_id_fkey"
            columns: ["listing_id"]
            isOneToOne: false
            referencedRelation: "listings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "listing_versions_previous_version_id_fkey"
            columns: ["previous_version_id"]
            isOneToOne: false
            referencedRelation: "listing_versions"
            referencedColumns: ["id"]
          },
        ]
      }
      listings: {
        Row: {
          active_pending_applications_count: number
          approved_submissions_count: number
          category: string
          closed_at: string | null
          created_at: string
          currency: string
          current_version_id: string | null
          description: string | null
          end_date: string | null
          id: string
          lister_id: string
          max_submissions: number | null
          min_followers_instagram: number | null
          min_followers_tiktok: number | null
          price_cents: number
          published_at: string | null
          status: Database["public"]["Enums"]["listing_status"]
          title: string
          updated_at: string
          version_bump_reason: string | null
          version_number: number
        }
        Insert: {
          active_pending_applications_count?: number
          approved_submissions_count?: number
          category?: string
          closed_at?: string | null
          created_at?: string
          currency?: string
          current_version_id?: string | null
          description?: string | null
          end_date?: string | null
          id?: string
          lister_id: string
          max_submissions?: number | null
          min_followers_instagram?: number | null
          min_followers_tiktok?: number | null
          price_cents: number
          published_at?: string | null
          status?: Database["public"]["Enums"]["listing_status"]
          title: string
          updated_at?: string
          version_bump_reason?: string | null
          version_number?: number
        }
        Update: {
          active_pending_applications_count?: number
          approved_submissions_count?: number
          category?: string
          closed_at?: string | null
          created_at?: string
          currency?: string
          current_version_id?: string | null
          description?: string | null
          end_date?: string | null
          id?: string
          lister_id?: string
          max_submissions?: number | null
          min_followers_instagram?: number | null
          min_followers_tiktok?: number | null
          price_cents?: number
          published_at?: string | null
          status?: Database["public"]["Enums"]["listing_status"]
          title?: string
          updated_at?: string
          version_bump_reason?: string | null
          version_number?: number
        }
        Relationships: [
          {
            foreignKeyName: "listings_current_version_fk"
            columns: ["current_version_id"]
            isOneToOne: false
            referencedRelation: "listing_versions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "listings_lister_id_fkey"
            columns: ["lister_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      metric_snapshots: {
        Row: {
          apify_run_id: string | null
          avg_views_last_10: number | null
          error_message: string | null
          fetched_at: string
          follower_count: number | null
          following_count: number | null
          id: string
          is_latest: boolean
          is_verified: boolean | null
          raw_payload: Json | null
          scrape_mode: Database["public"]["Enums"]["scrape_mode"]
          social_link_id: string
          status: Database["public"]["Enums"]["metric_status"]
          total_likes: number | null
          video_count: number | null
        }
        Insert: {
          apify_run_id?: string | null
          avg_views_last_10?: number | null
          error_message?: string | null
          fetched_at?: string
          follower_count?: number | null
          following_count?: number | null
          id?: string
          is_latest?: boolean
          is_verified?: boolean | null
          raw_payload?: Json | null
          scrape_mode: Database["public"]["Enums"]["scrape_mode"]
          social_link_id: string
          status: Database["public"]["Enums"]["metric_status"]
          total_likes?: number | null
          video_count?: number | null
        }
        Update: {
          apify_run_id?: string | null
          avg_views_last_10?: number | null
          error_message?: string | null
          fetched_at?: string
          follower_count?: number | null
          following_count?: number | null
          id?: string
          is_latest?: boolean
          is_verified?: boolean | null
          raw_payload?: Json | null
          scrape_mode?: Database["public"]["Enums"]["scrape_mode"]
          social_link_id?: string
          status?: Database["public"]["Enums"]["metric_status"]
          total_likes?: number | null
          video_count?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "metric_snapshots_social_link_id_fkey"
            columns: ["social_link_id"]
            isOneToOne: false
            referencedRelation: "social_links"
            referencedColumns: ["id"]
          },
        ]
      }
      notifications: {
        Row: {
          created_at: string
          id: string
          kind: Database["public"]["Enums"]["notification_kind"]
          payload: Json
          read_at: string | null
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          kind: Database["public"]["Enums"]["notification_kind"]
          payload: Json
          read_at?: string | null
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          kind?: Database["public"]["Enums"]["notification_kind"]
          payload?: Json
          read_at?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "notifications_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      push_tokens: {
        Row: {
          created_at: string
          expo_token: string
          id: string
          last_seen_at: string
          platform: string
          user_id: string
        }
        Insert: {
          created_at?: string
          expo_token: string
          id?: string
          last_seen_at?: string
          platform: string
          user_id: string
        }
        Update: {
          created_at?: string
          expo_token?: string
          id?: string
          last_seen_at?: string
          platform?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "push_tokens_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      sample_videos: {
        Row: {
          caption: string | null
          id: string
          listing_version_id: string
          platform: Database["public"]["Enums"]["platform"]
          sort_order: number
          url: string
        }
        Insert: {
          caption?: string | null
          id?: string
          listing_version_id: string
          platform: Database["public"]["Enums"]["platform"]
          sort_order?: number
          url: string
        }
        Update: {
          caption?: string | null
          id?: string
          listing_version_id?: string
          platform?: Database["public"]["Enums"]["platform"]
          sort_order?: number
          url?: string
        }
        Relationships: [
          {
            foreignKeyName: "sample_videos_listing_version_id_fkey"
            columns: ["listing_version_id"]
            isOneToOne: false
            referencedRelation: "listing_versions"
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
      submission_videos: {
        Row: {
          external_id: string | null
          id: string
          last_validated_at: string | null
          oembed_cached: Json | null
          platform: Database["public"]["Enums"]["platform"]
          sort_order: number
          submission_id: string
          url: string
        }
        Insert: {
          external_id?: string | null
          id?: string
          last_validated_at?: string | null
          oembed_cached?: Json | null
          platform: Database["public"]["Enums"]["platform"]
          sort_order?: number
          submission_id: string
          url: string
        }
        Update: {
          external_id?: string | null
          id?: string
          last_validated_at?: string | null
          oembed_cached?: Json | null
          platform?: Database["public"]["Enums"]["platform"]
          sort_order?: number
          submission_id?: string
          url?: string
        }
        Relationships: [
          {
            foreignKeyName: "submission_videos_submission_id_fkey"
            columns: ["submission_id"]
            isOneToOne: false
            referencedRelation: "submissions"
            referencedColumns: ["id"]
          },
        ]
      }
      submissions: {
        Row: {
          application_id: string
          cover_note: string | null
          created_at: string
          decided_at: string | null
          decision_note: string | null
          id: string
          override_by_user_id: string | null
          override_reason: string | null
          status: Database["public"]["Enums"]["submission_status"]
          updated_at: string
        }
        Insert: {
          application_id: string
          cover_note?: string | null
          created_at?: string
          decided_at?: string | null
          decision_note?: string | null
          id?: string
          override_by_user_id?: string | null
          override_reason?: string | null
          status?: Database["public"]["Enums"]["submission_status"]
          updated_at?: string
        }
        Update: {
          application_id?: string
          cover_note?: string | null
          created_at?: string
          decided_at?: string | null
          decision_note?: string | null
          id?: string
          override_by_user_id?: string | null
          override_reason?: string | null
          status?: Database["public"]["Enums"]["submission_status"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "submissions_application_id_fkey"
            columns: ["application_id"]
            isOneToOne: false
            referencedRelation: "applications"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "submissions_override_by_user_id_fkey"
            columns: ["override_by_user_id"]
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
      apify_webhook_persist_ig_details: {
        Args: {
          p_error_message: string
          p_fetched_at: string
          p_follower_count: number
          p_following_count: number
          p_is_verified: boolean
          p_media_count: number
          p_raw_payload: Json
          p_run_id: string
          p_social_link_id: string
          p_status: Database["public"]["Enums"]["metric_status"]
        }
        Returns: Json
      }
      apify_webhook_persist_ig_posts: {
        Args: {
          p_avg_views_last_10: number
          p_error_message: string
          p_fetched_at: string
          p_raw_payload: Json
          p_run_id: string
          p_social_link_id: string
          p_status: Database["public"]["Enums"]["metric_status"]
        }
        Returns: Json
      }
      apify_webhook_persist_tiktok_profile: {
        Args: {
          p_avg_views_last_10: number
          p_error_message: string
          p_fetched_at: string
          p_follower_count: number
          p_following_count: number
          p_is_verified: boolean
          p_raw_payload: Json
          p_run_id: string
          p_social_link_id: string
          p_status: Database["public"]["Enums"]["metric_status"]
          p_total_likes: number
          p_video_count: number
        }
        Returns: Json
      }
      apply_to_listing_rpc: {
        Args: {
          p_cover_note?: string
          p_creator_id: string
          p_expected_version_id: string
          p_listing_id: string
        }
        Returns: Json
      }
      auth_signup_creator: {
        Args: {
          p_instagram_handle?: string
          p_tiktok_handle?: string
          p_username: string
        }
        Returns: Json
      }
      auth_signup_lister: {
        Args: {
          p_email: string
          p_org_name: string
          p_username: string
          p_website_url?: string
        }
        Returns: Json
      }
      create_listing_rpc: {
        Args: { p_lister_id: string; p_payload: Json }
        Returns: Json
      }
      current_user_id: { Args: never; Returns: string }
      current_user_role: {
        Args: never
        Returns: Database["public"]["Enums"]["user_role"]
      }
      decide_application_rpc: {
        Args: {
          p_action: string
          p_application_id: string
          p_decision_note?: string
          p_expected_version_id?: string
          p_lister_id: string
        }
        Returns: Json
      }
      decide_submission_rpc: {
        Args: {
          p_action: string
          p_decision_note?: string
          p_lister_id: string
          p_override?: boolean
          p_override_reason?: string
          p_submission_id: string
        }
        Returns: Json
      }
      get_my_application_for_submit: {
        Args: { p_application_id: string }
        Returns: {
          application_id: string
          application_status: Database["public"]["Enums"]["application_status"]
          lister_handle: string
          listing_id: string
          listing_title: string
          listing_version_id: string
          post_conditions: Json
          version_title: string
        }[]
      }
      get_submission_for_lister_review: {
        Args: { p_caller_id?: string; p_submission_id: string }
        Returns: Json
      }
      list_discover_feed: {
        Args: { p_eligible_only?: boolean }
        Returns: {
          created_at: string
          currency: string
          id: string
          lister_handle: string
          min_followers_instagram: number
          min_followers_tiktok: number
          price_cents: number
          title: string
        }[]
      }
      list_my_applications: {
        Args: never
        Returns: {
          created_at: string
          id: string
          lister_handle: string
          listing_id: string
          listing_title: string
          status: Database["public"]["Enums"]["application_status"]
          version_title: string
        }[]
      }
      list_my_applications_as_lister: {
        Args: never
        Returns: {
          application_id: string
          cover_note: string
          created_at: string
          creator_user_id: string
          creator_username: string
          instagram_avg_views_last_10: number
          instagram_follower_count: number
          instagram_handle: string
          listing_id: string
          listing_title: string
          status: Database["public"]["Enums"]["application_status"]
          tiktok_follower_count: number
          tiktok_handle: string
        }[]
      }
      list_my_campaigns: {
        Args: never
        Returns: {
          applications_count: number
          created_at: string
          currency: string
          id: string
          min_followers_instagram: number
          min_followers_tiktok: number
          price_cents: number
          status: Database["public"]["Enums"]["listing_status"]
          submissions_count: number
          title: string
          updated_at: string
        }[]
      }
      list_my_submissions: {
        Args: never
        Returns: {
          application_id: string
          created_at: string
          id: string
          lister_handle: string
          listing_id: string
          listing_title: string
          status: Database["public"]["Enums"]["submission_status"]
          version_title: string
          video_platform: Database["public"]["Enums"]["platform"]
          video_url: string
        }[]
      }
      list_my_submissions_as_lister: {
        Args: never
        Returns: {
          application_id: string
          created_at: string
          creator_user_id: string
          creator_username: string
          decided_at: string
          instagram_handle: string
          listing_id: string
          listing_title: string
          reuse_count: number
          status: Database["public"]["Enums"]["submission_status"]
          submission_id: string
          tiktok_handle: string
          video_platform: Database["public"]["Enums"]["platform"]
          video_thumbnail_url: string
          video_url: string
        }[]
      }
      lister_dashboard_counts: {
        Args: never
        Returns: {
          active_campaigns: number
          pending_applications: number
          pending_submissions: number
        }[]
      }
      manage_social_link: {
        Args: {
          p_action: string
          p_handle?: string
          p_platform?: Database["public"]["Enums"]["platform"]
          p_social_link_id?: string
          p_user_id: string
        }
        Returns: Json
      }
      submission_reuse_count: {
        Args: { p_submission_id: string }
        Returns: number
      }
      submit_video_rpc: {
        Args: {
          p_application_id: string
          p_creator_id: string
          p_external_id?: string
          p_oembed?: Json
          p_platform: Database["public"]["Enums"]["platform"]
          p_video_url: string
        }
        Returns: Json
      }
      update_listing_samples_rpc: {
        Args: {
          p_confirm_cascade: boolean
          p_lister_id: string
          p_listing_id: string
          p_samples: Json
        }
        Returns: Json
      }
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
