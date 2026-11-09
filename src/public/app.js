
const loginForm = document.getElementById('loginForm');

if (loginForm) {
    loginForm.addEventListener('submit', async (event) => {
        event.preventDefault();

        const message = document.getElementById('message');
        const button = document.getElementById('loginButton');

        message.textContent = '';
        message.className = 'message';
        button.disabled = true;
        button.textContent = 'Signing in...';

        try {
            const response = await fetch('/api/auth/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'same-origin',
                body: JSON.stringify({
                    email: document.getElementById('email').value.trim(),
                    password: document.getElementById('password').value
                })
            });

            const data = await response.json();

            if (!response.ok) {
                throw new Error(data.message || 'Login failed.');
            }

            message.textContent = 'Login successful. Redirecting...';
            message.className = 'message success';

            if (data.user.role === 'admin') {
                window.location.href = '/admin.html';
            } else {
                window.location.href = '/dashboard.html';
            }
        } catch (error) {
            message.textContent = error.message || 'Could not connect to the server.';
            message.className = 'message error';
        } finally {
            button.disabled = false;
            button.textContent = 'Sign in';
        }
    });
}
