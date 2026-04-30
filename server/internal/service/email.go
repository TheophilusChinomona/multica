package service

import (
	"bytes"
	"crypto/tls"
	"fmt"
	"html"
	"net"
	"net/smtp"
	"os"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/resend/resend-go/v2"
)

// maxSubjectFieldRunes bounds how much user-controlled text (workspace name,
// inviter name) can land in an email Subject. Prevents attackers from stuffing
// a full phishing pitch into a workspace name that gets sent from our domain.
const maxSubjectFieldRunes = 60

type smtpConfig struct {
	host     string
	port     string
	user     string
	password string
	from     string
}

type EmailService struct {
	resendClient *resend.Client
	smtp         *smtpConfig
	fromEmail    string
}

func NewEmailService() *EmailService {
	svc := &EmailService{}

	// SMTP takes priority over Resend when SMTP_HOST is set.
	if host := os.Getenv("SMTP_HOST"); host != "" {
		port := os.Getenv("SMTP_PORT")
		if port == "" {
			port = "587"
		}
		from := os.Getenv("SMTP_FROM_EMAIL")
		if from == "" {
			from = os.Getenv("RESEND_FROM_EMAIL")
		}
		if from == "" {
			from = "noreply@multica.ai"
		}
		svc.smtp = &smtpConfig{
			host:     host,
			port:     port,
			user:     os.Getenv("SMTP_USER"),
			password: os.Getenv("SMTP_PASSWORD"),
			from:     from,
		}
		svc.fromEmail = from
		return svc
	}

	// Fall back to Resend.
	apiKey := os.Getenv("RESEND_API_KEY")
	from := os.Getenv("RESEND_FROM_EMAIL")
	if from == "" {
		from = "noreply@multica.ai"
	}
	svc.fromEmail = from
	if apiKey != "" {
		svc.resendClient = resend.NewClient(apiKey)
	}
	return svc
}

// sendSMTP sends an HTML email via SMTP (STARTTLS on port 587, implicit TLS on 465).
func (s *EmailService) sendSMTP(to, subject, htmlBody string) error {
	cfg := s.smtp
	addr := net.JoinHostPort(cfg.host, cfg.port)

	msg := buildMIMEMessage(cfg.from, to, subject, htmlBody)

	var auth smtp.Auth
	if cfg.user != "" {
		auth = smtp.PlainAuth("", cfg.user, cfg.password, cfg.host)
	}

	if cfg.port == "465" {
		// Implicit TLS (SMTPS)
		tlsCfg := &tls.Config{ServerName: cfg.host}
		conn, err := tls.Dial("tcp", addr, tlsCfg)
		if err != nil {
			return fmt.Errorf("smtp tls dial: %w", err)
		}
		client, err := smtp.NewClient(conn, cfg.host)
		if err != nil {
			return fmt.Errorf("smtp new client: %w", err)
		}
		defer client.Close()
		if auth != nil {
			if err := client.Auth(auth); err != nil {
				return fmt.Errorf("smtp auth: %w", err)
			}
		}
		if err := client.Mail(cfg.from); err != nil {
			return err
		}
		if err := client.Rcpt(to); err != nil {
			return err
		}
		w, err := client.Data()
		if err != nil {
			return err
		}
		if _, err := w.Write(msg); err != nil {
			return err
		}
		return w.Close()
	}

	// STARTTLS (port 587 / 25)
	return smtp.SendMail(addr, auth, cfg.from, []string{to}, msg)
}

func buildMIMEMessage(from, to, subject, htmlBody string) []byte {
	var buf bytes.Buffer
	buf.WriteString("From: " + from + "\r\n")
	buf.WriteString("To: " + to + "\r\n")
	buf.WriteString("Subject: " + subject + "\r\n")
	buf.WriteString("MIME-Version: 1.0\r\n")
	buf.WriteString("Content-Type: text/html; charset=\"UTF-8\"\r\n")
	buf.WriteString("\r\n")
	buf.WriteString(htmlBody)
	return buf.Bytes()
}

// SendVerificationCode sends a one-time login code. The code is server-generated
// (6-digit numeric) so no user-controlled text reaches the email body here.
// If that ever changes, escape the user-controlled fields the same way
// SendInvitationEmail does.
func (s *EmailService) SendVerificationCode(to, code string) error {
	subject := "Your Multica verification code"
	body := fmt.Sprintf(
		`<div style="font-family: sans-serif; max-width: 400px; margin: 0 auto;">
			<h2>Your verification code</h2>
			<p style="font-size: 32px; font-weight: bold; letter-spacing: 8px; margin: 24px 0;">%s</p>
			<p>This code expires in 10 minutes.</p>
			<p style="color: #666; font-size: 14px;">If you didn't request this code, you can safely ignore this email.</p>
		</div>`, code)

	if s.smtp != nil {
		return s.sendSMTP(to, subject, body)
	}
	if s.resendClient != nil {
		_, err := s.resendClient.Emails.Send(&resend.SendEmailRequest{
			From: s.fromEmail, To: []string{to}, Subject: subject, Html: body,
		})
		return err
	}
	fmt.Printf("[DEV] Verification code for %s: %s\n", to, code)
	return nil
}

// SendInvitationEmail notifies the invitee that they have been invited to a workspace.
// invitationID is included in the URL so the email deep-links to /invite/{id}.
//
// FRONTEND_ORIGIN is required: this is a self-host fork, so there is no
// hosted-domain fallback to silently route invite links to. Misconfigurations
// must fail loudly at send time, not deliver clickless emails to recipients.
func (s *EmailService) SendInvitationEmail(to, inviterName, workspaceName, invitationID string) error {
	appURL := strings.TrimSpace(os.Getenv("FRONTEND_ORIGIN"))
	if appURL == "" {
		return fmt.Errorf("cannot send invitation email: FRONTEND_ORIGIN is unset, so invite links would not resolve to your self-hosted instance")
	}
	inviteURL := fmt.Sprintf("%s/invite/%s", appURL, invitationID)

	if s.smtp != nil {
		params := buildInvitationParams(s.fromEmail, to, inviterName, workspaceName, inviteURL)
		return s.sendSMTP(to, params.Subject, params.Html)
	}
	if s.resendClient != nil {
		params := buildInvitationParams(s.fromEmail, to, inviterName, workspaceName, inviteURL)
		_, err := s.resendClient.Emails.Send(params)
		return err
	}
	fmt.Printf("[DEV] Invitation email to %s: %s invited you to %s — %s\n", to, inviterName, workspaceName, inviteURL)
	return nil
}

// buildInvitationParams assembles the email request for an invitation.
// Separated so the sanitization behavior is unit-testable without needing
// to mock the Resend SDK.
func buildInvitationParams(from, to, inviterName, workspaceName, inviteURL string) *resend.SendEmailRequest {
	safeWorkspace := html.EscapeString(workspaceName)
	safeInviter := html.EscapeString(inviterName)
	subjectInviter := sanitizeSubjectField(inviterName)
	subjectWorkspace := sanitizeSubjectField(workspaceName)

	return &resend.SendEmailRequest{
		From:    from,
		To:      []string{to},
		Subject: fmt.Sprintf("%s invited you to %s on Multica", subjectInviter, subjectWorkspace),
		Html: fmt.Sprintf(
			`<div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
				<h2>You're invited to join %s</h2>
				<p><strong>%s</strong> invited you to collaborate in the <strong>%s</strong> workspace on Multica.</p>
				<p style="margin: 24px 0;">
					<a href="%s" style="display: inline-block; padding: 12px 24px; background: #000; color: #fff; text-decoration: none; border-radius: 6px; font-weight: 500;">Accept invitation</a>
				</p>
				<p style="color: #666; font-size: 14px;">You'll need to log in to accept or decline the invitation.</p>
			</div>`, safeWorkspace, safeInviter, safeWorkspace, inviteURL),
	}
}

// sanitizeSubjectField prepares user-controlled text for the email Subject line.
// Subject is not HTML-rendered, so HTML-escaping would leak literal entities
// (e.g. &lt;script&gt;) into the recipient's inbox. Instead strip control
// characters (defense in depth against header-injection-adjacent abuse even
// though Resend also filters CR/LF) and cap length so attackers can't stuff
// a full phishing subject into a workspace name.
func sanitizeSubjectField(s string) string {
	var b strings.Builder
	b.Grow(len(s))
	for _, r := range s {
		if unicode.IsControl(r) {
			continue
		}
		b.WriteRune(r)
	}
	cleaned := b.String()
	if utf8.RuneCountInString(cleaned) <= maxSubjectFieldRunes {
		return cleaned
	}
	runes := []rune(cleaned)
	return string(runes[:maxSubjectFieldRunes-1]) + "…"
}
