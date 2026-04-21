import { Injectable, inject } from '@angular/core';
import { SupabaseService } from './supabase-service';

export interface NewsItem {
  id: string;
  title: string;
  body: string;
  tag: string | null;
  tag_color: string;
  image_url: string | null;
  link_label: string | null;
  link_url: string | null;
  is_active: boolean;
  send_notification: boolean;
  notification_sent: boolean;
  scheduled_at: string | null;
  published_at: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface NewsCreateInput {
  title: string;
  body: string;
  tag?: string;
  tag_color?: string;
  image_url?: string;
  link_label?: string;
  link_url?: string;
  is_active?: boolean;
  send_notification?: boolean;
  scheduled_at?: string | null;
}

export type NewsStatus = 'draft' | 'scheduled' | 'published' | 'inactive';

@Injectable({ providedIn: 'root' })
export class NewsService {
  private supabase = inject(SupabaseService);

  getStatus(item: NewsItem): NewsStatus {
    if (!item.is_active) return 'inactive';
    if (item.published_at) return 'published';
    if (item.scheduled_at) return 'scheduled';
    return 'draft';
  }

  async getActiveNews(): Promise<NewsItem[]> {
    const client = this.supabase.client;
    const { data, error } = await client
      .from('news')
      .select('*')
      .eq('is_active', true)
      .not('published_at', 'is', null)
      .order('published_at', { ascending: false });

    if (error) throw error;
    return data ?? [];
  }

  async getAllNews(): Promise<NewsItem[]> {
    const client = this.supabase.client;
    const { data, error } = await client
      .from('news')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) throw error;
    return data ?? [];
  }

  async createNews(input: NewsCreateInput, userId: string): Promise<NewsItem> {
    const client = this.supabase.client;
    const now = new Date().toISOString();

    const publishNow = input.is_active && !input.scheduled_at;

    const { data, error } = await client
      .from('news')
      .insert({
        title: input.title,
        body: input.body,
        tag: input.tag || null,
        tag_color: input.tag_color || 'red',
        image_url: input.image_url || null,
        link_label: input.link_label || null,
        link_url: input.link_url || null,
        is_active: input.is_active ?? false,
        send_notification: input.send_notification ?? false,
        scheduled_at: input.scheduled_at || null,
        published_at: publishNow ? now : null,
        created_by: userId
      })
      .select()
      .single();

    if (error) throw error;
    return data;
  }

  async updateNews(id: string, input: Partial<NewsCreateInput>): Promise<NewsItem> {
    const client = this.supabase.client;

    const updates: any = { ...input };

    // If activating without a schedule, set published_at now
    if (input.is_active && !input.scheduled_at) {
      const existing = await this.getById(id);
      if (!existing?.published_at) {
        updates.published_at = new Date().toISOString();
      }
    }

    const { data, error } = await client
      .from('news')
      .update(updates)
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;
    return data;
  }

  async deleteNews(id: string): Promise<void> {
    const client = this.supabase.client;
    const { error } = await client.from('news').delete().eq('id', id);
    if (error) throw error;
  }

  async getById(id: string): Promise<NewsItem | null> {
    const client = this.supabase.client;
    const { data, error } = await client
      .from('news')
      .select('*')
      .eq('id', id)
      .single();

    if (error) return null;
    return data;
  }

  async uploadImage(file: File, newsId: string): Promise<string> {
    const client = this.supabase.client;
    const ext = file.name.split('.').pop();
    const path = `${newsId}/${Date.now()}.${ext}`;

    const { error } = await client.storage
      .from('news-images')
      .upload(path, file, { upsert: true });

    if (error) throw error;

    const { data } = client.storage.from('news-images').getPublicUrl(path);
    return data.publicUrl;
  }
}
