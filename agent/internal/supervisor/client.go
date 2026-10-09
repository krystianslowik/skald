package supervisor

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"net/http"
)

type Client struct {
	url, user, pass string
	http            *http.Client
}

// New builds a client. Timeouts come from the caller's context, not the
// http.Client: stopProcess with wait=true blocks until Valheim has saved the
// world and exited, which can take minutes.
func New(url, user, pass string) *Client {
	return &Client{url: url, user: user, pass: pass, http: &http.Client{}}
}

// ProcessInfo is the subset of getAllProcessInfo fields the agent uses.
type ProcessInfo struct {
	Name      string
	Group     string
	StateName string
	Start     int64 // unix seconds; 0 if never started
}

func (c *Client) call(ctx context.Context, method string, params ...any) (any, error) {
	body, err := encodeCall(method, params...)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.url, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "text/xml")
	if c.user != "" || c.pass != "" {
		req.SetBasicAuth(c.user, c.pass)
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, fmt.Errorf("%s: %w", method, err)
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if err != nil {
		return nil, fmt.Errorf("%s: %w", method, err)
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("%s: http %d", method, resp.StatusCode)
	}
	v, err := decodeResponse(raw)
	if err != nil {
		return nil, fmt.Errorf("%s: %w", method, err)
	}
	return v, nil
}

func (c *Client) GetAllProcessInfo(ctx context.Context) ([]ProcessInfo, error) {
	v, err := c.call(ctx, "supervisor.getAllProcessInfo")
	if err != nil {
		return nil, err
	}
	arr, ok := v.([]any)
	if !ok {
		return nil, fmt.Errorf("getAllProcessInfo: unexpected %T", v)
	}
	out := make([]ProcessInfo, 0, len(arr))
	for _, e := range arr {
		m, ok := e.(map[string]any)
		if !ok {
			continue
		}
		p := ProcessInfo{}
		p.Name, _ = m["name"].(string)
		p.Group, _ = m["group"].(string)
		p.StateName, _ = m["statename"].(string)
		if s, ok := m["start"].(int); ok {
			p.Start = int64(s)
		}
		out = append(out, p)
	}
	return out, nil
}

func (c *Client) SignalProcess(ctx context.Context, name, signal string) error {
	_, err := c.call(ctx, "supervisor.signalProcess", name, signal)
	return err
}

func (c *Client) StopProcess(ctx context.Context, name string, wait bool) error {
	_, err := c.call(ctx, "supervisor.stopProcess", name, wait)
	return err
}

func (c *Client) StartProcess(ctx context.Context, name string, wait bool) error {
	_, err := c.call(ctx, "supervisor.startProcess", name, wait)
	return err
}
